#!/usr/bin/env node
/* vim: set ts=8 sts=8 sw=8 noet: */

'use strict';

var mod_assert = require('assert-plus');
var mod_restify = require('restify');
var mod_bunyan = require('bunyan');
var mod_fs = require('fs');
var mod_jiramark = require('jiramark');
var mod_path = require('path');
var mod_ent = require('ent');
var mod_url = require('url');
var mod_vasync = require('vasync');
var mod_verror = require('verror');

var lib_backend_jira = require('./lib/backend_jira');
var lib_backend_files = require('./lib/backend_files');

var VE = mod_verror.VError;

var LOG = mod_bunyan.createLogger({
	name: 'jirapub',
	level: process.env.LOG_LEVEL || mod_bunyan.INFO
});

var HEADING_LEVELS = [ 1, 2, 3, 4, 5, 6 ].map(function (l) {
	return ('' + l);
});

/*
 * JIRA issues contain a number of properties that are object-valued.  When
 * copying these into the sanitised view, we only preserve the subset of keys
 * that are meaningful and safe to expose.
 */
var ISSUE_OBJECT_KEYS = [
	'id',
	'name',
	'description',
	'key',
	'emailAddress',
	'displayName'
];

/*
 * Issues can also contain a list of software release versions.  The list of
 * meaningful properties is slightly different to the more generic object
 * values mentioned above.
 */
var RELEASE_OBJECT_KEYS = [
	'id',
	'name',
	'archived',
	'released',
	'releaseDate'
];

var TEMPLATES = {};
var TEMPLATE_RE = /%%([^%]*)%%/g;

var UNRESTRICTED = false;
var CONFIG = read_config(LOG);

var ALLOWED_DOMAINS = CONFIG.allowed_domains;
var ALLOWED_LABELS = CONFIG.allowed_labels;

var BACKEND;
var SERVER; // eslint-disable-line

var JIRA_OPS = {
	formatLink: format_remote_link
};

/*
 * Initialisation Routines:
 */

function
read_templates(log)
{
	var tdir = mod_path.join(__dirname, 'templates');
	var ents = mod_fs.readdirSync(tdir);

	for (var i = 0; i < ents.length; i++) {
		var path = mod_path.join(tdir, ents[i]);
		var nam = ents[i].replace(/\.[^.]*$/, '');

		log.info({
			template_name: nam,
			path: path
		}, 'load template');
		TEMPLATES[nam] = mod_fs.readFileSync(path, 'utf8');
	}
}

function
read_config(log)
{
	var p = mod_path.join(__dirname, 'config.json');
	var f = mod_fs.readFileSync(p, 'utf8');
	var c = JSON.parse(f);

	try {
		var CHECK = [ 'username', 'password', 'url', 'label', 'port',
		    'http_proto' ];
		for (var i = 0; i < CHECK.length; i++) {
			mod_assert.ok(c[CHECK[i]], 'config.' + CHECK[i]);
		}
		mod_assert.string(c.url.base, 'config.url.base');
		mod_assert.string(c.url.path, 'config.url.path');
		mod_assert.arrayOfString(c.allowed_domains,
		    'config.allowed_domains');
		mod_assert.arrayOfString(c.allowed_labels,
		    'config.allowed_labels');
	} catch (ex) {
		log.error(ex, 'configuration validation failed');
		process.exit(1);
	}

	return (c);
}

function
create_http_server(log, callback)
{
	var s = mod_restify.createServer({
		name: 'jirapub',
		log: log.child({
			component: 'http'
		})
	});

	s.use(mod_restify.queryParser({
		mapParams: false
	}));

	s.get(/^\/bugview\/*$/, function (req, res, next) {
		var base = req.url.replace(/\/*$/, '');

		res.header('Location', base + '/index.html');
		res.send(302);
		next(false);
	});
	s.get('/bugview/index.html', handle_issue_index.bind(null, 'html'));
	s.get('/bugview/index.json', handle_issue_index.bind(null, 'json'));
	s.get('/bugview/label/:key', handle_label_index.bind(null, 'html'));
	s.get('/bugview/json/:key', handle_issue_json);
	s.get('/bugview/fulljson/:key', handle_issue.bind(null, 'json'));
	s.get('/bugview/:key', handle_issue.bind(null, 'html'));

	s.on('uncaughtException', function (req, res, _route, err) {
		req.log.error(err, 'uncaught exception!');
	});

	s.listen(CONFIG.port, function (err) {
		if (err) {
			log.error(err, 'http listen error');
			process.exit(1);
		}

		log.info({
			port: CONFIG.port
		}, 'http listening');

		callback(s);
	});
}

/*
 * Route Handlers:
 */

function
template(nam)
{
	mod_assert.string(nam, 'nam');
	mod_assert.string(TEMPLATES[nam], 'TEMPLATES["' + nam + '"]');

	return (TEMPLATES[nam]);
}

/*
 * Load a given template and replace the %%KEY%% items with values from
 * the provided object.
 */
function
format_template(nam, keys)
{
	var out = template(nam);

	function replaceKey(orig, key) {
		if (keys.hasOwnProperty(key)) {
			return (keys[key]);
		} else {
			return (orig);
		}
	}

	return (out.replace(TEMPLATE_RE, replaceKey));
}

/*
 * Format a page using the primary.html template.
 */
function
format_primary(title, content)
{
	mod_assert.string(title, 'title');
	mod_assert.string(content, 'content');

	var keys = {
		'CONTAINER': content,
		'HTTP': CONFIG.http_proto,
		'TITLE': title
	};

	return (format_template('primary', keys));
}

/*
 * Check whether a label is one of the ones we're allowed to display.
 */
function
is_allowed_label(label)
{
	return (ALLOWED_LABELS.indexOf(label) !== -1);
}


function
handle_issue_index(format, req, res, next)
{
	var log = req.log.child({
		remoteAddress: req.socket.remoteAddress,
		remotePort: req.socket.remotePort,
		userAgent: req.headers['user-agent'],
		referrer: req.headers['referrer'],
		forwardedFor: req.headers['x-forwarded-for'],
		issue_index: true
	});

	make_issue_index(log, format, UNRESTRICTED ? null : CONFIG.label, req,
	    res, next);
}


function
handle_label_index(format, req, res, next)
{
	var log = req.log.child({
		remoteAddress: req.socket.remoteAddress,
		remotePort: req.socket.remotePort,
		userAgent: req.headers['user-agent'],
		referrer: req.headers['referrer'],
		forwardedFor: req.headers['x-forwarded-for'],
		label: req.params.key
	});
	var label = req.params.key;

	if (!UNRESTRICTED && !is_allowed_label(label)) {
		log.error({label: label}, 'request for non-public label');
		res.send(403, 'Sorry, this label does not exist.\n');
		next(false);
		return;
	}

	make_issue_index(log, format, label, req, res, next);
}


function
make_issue_index(log, format, label, req, res, next)
{
	var offset;

	mod_assert.ok(label === CONFIG.label ||
	    is_allowed_label(label) ||
	    UNRESTRICTED);

	if (req.query && req.query.offset) {
		offset = parseInt(req.query.offset, 10);
	}
	if (!offset || isNaN(offset) || offset < 0 || offset > 10000000) {
		offset = 0;
	}
	offset = Math.floor(offset / 50) * 50;

	var valid_sorts = [ 'key', 'created', 'updated' ];
	var sort = 'updated';
	if (req.query.sort && valid_sorts.indexOf(req.query.sort) !== -1) {
		sort = req.query.sort;
	}

	var labels = [];
	if (!UNRESTRICTED) {
		labels.push(CONFIG.label);
	}
	if (label !== null && labels.indexOf(label) === -1) {
		labels.push(label);
	}

	log.info({
		labels: labels,
		offset: offset
	}, 'fetch from %s', BACKEND.be_name);

	BACKEND.be_issue_list(labels, offset, sort, function (err, results) {
		if (err) {
			log.error(err, 'error communicating with JIRA');
			res.send(500);
			next(false);
			return;
		}

		var total = Number(results.total) || 10000000;
		var out;
		var i;

		if (offset > total && format === 'html') {
			var x = Math.max(total - 50, 0);
			log.info({
				offset: offset,
				total: total,
				redir_offset: x
			}, 'redirecting to last page');
			res.header('Location', 'index.html?offset=' + x);
			res.send(302);
			next(false);
			return;
		}

		log.info({
			offset: offset,
			total: total,
			format: format
		}, 'serving issue index');

		if (format !== 'html') {
			var resout = {
				offset: offset,
				total: total,
				sort: sort,
				issues: []
			};

			for (i = 0; i < results.issues.length; i++) {
				var ri = results.issues[i];

				resout.issues.push({
					id: ri.id,
					key: ri.key,
					synopsis: ri.fields.summary,
					resolution: ri.fields.resolution ?
					    ri.fields.resolution.name : null,
					updated: ri.fields.updated,
					created: ri.fields.created
				});
			}

			out = JSON.stringify(resout, null, 4);

			/*
			 * Deliver response to client:
			 */
			res.contentType = 'application/json';
			res.contentLength = out.length;

			res.writeHead(200);
			res.write(out);
			res.end();

			next();
			return;
		}

		/*
		 * Construct Issue Index table:
		 */
		var labeltxt = !is_allowed_label(label) ? '' : ': ' + label;
		var labelidx = ALLOWED_LABELS.map(function make_link(_label) {
			return make_label_link(_label, label === _label);
		}).join(', ');
		var tbody = '';
		for (i = 0; i < results.issues.length; i++) {
			var issue = results.issues[i];
			var resolution = '&nbsp';

			if (issue.fields.resolution &&
			    issue.fields.resolution.name) {
				resolution = issue.fields.resolution.name;
			}

			tbody += [
				'<tr><td>',
				'<a href="/bugview/' + issue.key + '">',
				issue.key,
				'</a>',
				'</td><td>',
				resolution,
				'</td><td>',
				issue.fields.summary,
				'</td></tr>'
			].join('') + '\n';
		}

		/*
		 * Construct paginated navigation links:
		 */
		var pagin = [];
		var page = is_allowed_label(label) ? label : 'index.html';
		pagin.push('<a href="' + page + '"?offset=0&sort=' + sort +
		    '">First Page</a>');
		if (offset > 0) {
			pagin.push('<a href="' + page + '?offset=' +
			    Math.max(offset - 50, 0) + '&sort=' + sort +
			    '">Previous Page</a>');
		}
		if (total) {
			var count = Math.min(50, total - offset);
			pagin.push('Displaying from ' + offset + ' to ' +
			    (count + offset) + ' of ' + total);
		}
		if ((offset + 50) <= total) {
			var nextp = (offset + 50) + '';
			pagin.push('<a href="' + page + '?offset=' +
			    nextp + '&sort=' + sort + '">Next Page</a>');
		}

		var container = format_template('issue_index', {
			LABEL: labeltxt,
			LABEL_INDEX: labelidx,
			PAGINATION: pagin.join(' | '),
			TABLE_BODY: tbody
		});

		/*
		 * Construct page from primary template and our table:
		 */
		out = format_primary('SmartOS Public Issues Index', container);

		/*
		 * Deliver response to client:
		 */
		res.contentType = 'text/html';
		res.contentLength = out.length;

		res.writeHead(200);
		res.write(out);
		res.end();

		next();
		return;
	});
}

function
handle_issue_json(req, res, next)
{
	var log = req.log.child({
		remoteAddress: req.socket.remoteAddress,
		remotePort: req.socket.remotePort,
		userAgent: req.headers['user-agent'],
		referrer: req.headers['referrer'],
		forwardedFor: req.headers['x-forwarded-for'],
		issue: req.params.key
	});

	if (!req.params.key || !req.params.key.match(/^[A-Z]+-[0-9]+$/)) {
		log.error({ key: req.params.key }, 'invalid "key" provided');
		res.send(400);
		next(false);
		return;
	}

	BACKEND.be_issue_get(req.params.key, function (err, issue) {
		if (err) {
			if (VE.info(err).notfound) {
				log.error(err, 'could not find issue');
				res.send(404);
				next(false);
				return;
			}
			log.error(err, 'error communicating with JIRA');
			res.send(500);
			next(false);
			return;
		}

		mod_assert.arrayOfString(issue.fields.labels, 'labels');

		if (!UNRESTRICTED &&
		    issue.fields.labels.indexOf(CONFIG.label) === -1) {
			log.error('request for non-public issue');
			res.send(403);
			next(false);
			return;
		}

		log.info({ issue_id: issue.id }, 'serving issue');

		/*
		 * Construct our page from the primary template with the
		 * formatted issue in the container:
		 */
		var out = format_issue_json(issue);

		/*
		 * Deliver response to client:
		 */
		res.contentType = 'application/json';
		res.contentLength = out.length;

		res.writeHead(200);
		res.write(out);
		res.end();

		next();
		return;
	});
}

function
handle_issue(format, req, res, next)
{
	var log = req.log.child({
		remoteAddress: req.socket.remoteAddress,
		remotePort: req.socket.remotePort,
		userAgent: req.headers['user-agent'],
		referrer: req.headers['referrer'],
		forwardedFor: req.headers['x-forwarded-for'],
		issue: req.params.key
	});

	if (!req.params.key || !req.params.key.match(/^[A-Z]+-[0-9]+$/)) {
		log.error({ key: req.params.key }, 'invalid "key" provided');
		res.send(400);
		next(false);
		return;
	}

	BACKEND.be_issue_get(req.params.key, function (err, issue) {
		if (err) {
			if (VE.info(err).notfound) {
				log.error(err, 'could not find issue');
				res.send(404,
				    'Sorry, that issue does not exist.\n');
				next(false);
				return;
			}
			log.error(err, 'error communicating with JIRA');
			res.send(500);
			next(false);
			return;
		}

		mod_assert.arrayOfString(issue.fields.labels, 'labels');

		if (!UNRESTRICTED &&
		    issue.fields.labels.indexOf(CONFIG.label) === -1) {
			log.error('request for non-public issue');
			res.send(403, 'Sorry, this issue is not public.\n');
			next(false);
			return;
		}

		log.info({ issue_id: issue.id }, 'serving issue');

		/*
		 * Construct our page from the primary template with the
		 * formatted issue in the container:
		 */
		format_issue({ format: format, issue: issue, log: log },
		    function (_err, formatted) {
			if (_err) {
				log.error(_err, 'format issue failed');
				res.send(500);
				next(false);
				return;
			}

			/*
			 * Deliver response to client:
			 */
			var out;
			if (format === 'html') {
				out = format_primary(format_issue_title(issue),
				    formatted);
				res.contentType = 'text/html';
			} else {
				out = formatted;
				res.contentType = 'application/json';
			}
			res.contentLength = out.length;

			res.writeHead(200);
			res.write(out);
			res.end();

			next();
			return;
		});
	});
}

/*
 * Formatter:
 */

/*
 * Access to issues is restricted to those with the correct label.  This
 * includes related issues, each of which must be checked for the "public"
 * label before display.
 */
function
allow_issue(key, other_issues)
{
	mod_assert.string(key, 'key');
	mod_assert.object(other_issues, 'other_issues');

	var m = key.match(/^([A-Z]+)-([0-9]+)/);
	if (!m) {
		return (false);
	}

	if (!other_issues[key]) {
		return (false);
	}

	if (!UNRESTRICTED &&
	    other_issues[key].fields.labels.indexOf(CONFIG.label) === -1) {
		return (false);
	}

	return (true);
}

function
fix_url(input)
{
	var out = input.trim();
	var url;

	var SUBS = {
		'mo.joyent.com': [
			{
				h: 'github.com',
				m: '/illumos-joyent',
				p: '/joyent/illumos-joyent'
			},
			{
				h: 'github.com',
				m: '/smartos-live',
				p: '/joyent/smartos-live'
			},
			{
				h: 'github.com',
				m: '/illumos-live',
				p: '/joyent/smartos-live'
			},
			{
				h: 'github.com',
				m: '/illumos-extra',
				p: '/joyent/illumos-extra'
			},
			{
				h: 'github.com',
				m: '/sdc-napi',
				p: '/joyent/sdc-napi'
			}
		]
	};

	try {
		url = mod_url.parse(out);
	} catch (ex) {
		LOG.error({
			err: ex,
			url: out
		}, 'url parse error');
		return (out);
	}

	if (!SUBS[url.hostname]) {
		return (mod_ent.encode(out));
	}

	for (var i = 0; i < SUBS[url.hostname].length; i++) {
		var s = SUBS[url.hostname][i];
		var re = new RegExp('^' + s.m);

		if (re.test(url.pathname)) {
			url.hostname = url.host = s.h;
			url.path = url.pathname =
			    url.pathname.replace(re, s.p);
			return (mod_ent.encode(mod_url.format(url)));
		}
	}

	return (mod_ent.encode(out));
}

/*
 * If this character appears before a formatting character, such as "*" or "_",
 * then the formatting character takes effect.  Used to allow formatting
 * characters to appear mid-word without being interpreted as a formatting
 * character.
 */
function
prefmtok(x)
{
	if (x === null) {
		return (true);
	}

	var cc_A = 'A'.charCodeAt(0);
	var cc_a = 'a'.charCodeAt(0);
	var cc_Z = 'Z'.charCodeAt(0);
	var cc_z = 'z'.charCodeAt(0);

	var cc = x.charCodeAt(0);

	if ((cc >= cc_A && cc <= cc_Z) ||
	    (cc >= cc_a && cc <= cc_z)) {
		return (false);
	}

	return (true);
}

function
repeat_char(c, n)
{
	var out = '';

	while (out.length < n) {
		out += c;
	}

	return (out);
}

/*
 * Make some attempt to parse JIRA markup.  This is neither rigorous, nor
 * even particularly compliant, but it improves the situation somewhat.
 */
function
parse_jira_markup(desc, ps)
{
	var text = '';
	var formats = [];
	var out = [];
	var state = 'LEADING_SPACES';
	var link_title = '';
	var link_url = '';
	var leading_spaces = 0;

	ps.ps_heading = null;

	function commit_text() {
		if (text !== '') {
			out.push(mod_ent.encode(text));
			text = '';
		}
	}

	for (var i = 0; i < desc.length; i++) {
		var c = desc[i];
		var cc = desc[i + 1];
		var ccc = desc[i + 2];
		var pc = i > 0 ? desc[i - 1] : null;

		mod_assert.notStrictEqual(c, '\n');
		mod_assert.notStrictEqual(c, '\r');

		switch (state) {
		case 'LEADING_SPACES':
			if (c === ' ') {
				leading_spaces++;
				continue;
			} else if ((c === '*' || c === '-') && cc === ' ') {
				if (ps.ps_list) {
					out.push('</li>');
				} else {
					out.push('<ul>');
				}
				ps.ps_list = 'ul';
				commit_text();
				out.push('<li>');
				continue;
			} else if (c === '#' && cc === ' ') {
				if (ps.ps_list) {
					out.push('</li>');
				} else {
					out.push('<ol>');
				}
				ps.ps_list = 'ol';
				commit_text();
				out.push('<li>');
				continue;
			}


			/*
			 * No special sequence was detected, so emit the
			 * spaces we counted, switch to the TEXT state, and
			 * wind back by one character so we reprocess the
			 * character we're looking at now.
			 */
			text += repeat_char(' ', leading_spaces);
			state = 'TEXT';
			i--;
			continue;

		case 'TEXT':
			if (ps.ps_list && i === 0 && c !== ' ') {
				commit_text();
				out.push('</li></' + ps.ps_list + '>');
				ps.ps_list = null;

				/*
				 * Note that we must break out here, so that
				 * we don't drop this character.
				 */
				break;
			}

			if (i === 0 && c === 'h' && ccc === '.' &&
			    HEADING_LEVELS.indexOf(cc) !== -1) {
				ps.ps_heading = 'h' + cc;
				commit_text();
				out.push('<' + ps.ps_heading + '>');
				i += 3;
				continue;
			}

			if (c === '[') {
				commit_text();
				link_title = '';
				link_url = '';
				if (cc === '~') {
					i++; /* skip cc */
					state = 'LINK_USER';
				} else if (cc === '^') {
					i++; /* skip cc */
					state = 'LINK_ATTACHMENT';
				} else {
					state = 'LINK_TITLE';
				}
				continue;
			}
			break;

		case 'LINK_TITLE':
			if (c === '|') {
				state = 'LINK_URL';
			} else if (c === ']') {
				out.push(format_remote_link(link_title,
				    mod_ent.encode(link_title)));

				state = 'TEXT';
			} else {
				link_title += c;
			}
			continue;

		case 'LINK_USER':
			if (c === ']') {
				out.push('<b>@');
				out.push(mod_ent.encode(link_title));
				out.push('</b>');

				state = 'TEXT';
			} else {
				link_title += c;
			}
			continue;

		case 'LINK_ATTACHMENT':
			if (c === ']') {
				out.push('<b>[attachment ');
				out.push(mod_ent.encode(link_title));
				out.push(']</b>');

				state = 'TEXT';
			} else {
				link_title += c;
			}
			continue;

		case 'LINK_URL':
			if (c === ']') {
				out.push(format_remote_link(link_url,
				    mod_ent.encode(link_title)));

				state = 'TEXT';
			} else {
				link_url += c;
			}
			continue;
		default:
			throw new Error(
			    'unknown state: ' + JSON.stringify(state));
		}

		if (c === '*' && formats[0] !== 'CODE') {
			commit_text();
			if (formats[0] === 'BOLD') {
				formats.pop();
				out.push('</b>');
				continue;
			} else if (prefmtok(pc)) {
				formats.push('BOLD');
				out.push('<b>');
				continue;
			}
		}

		if (c === '_' && formats[0] !== 'CODE') {
			commit_text();
			if (formats[0] === 'ITALIC') {
				formats.pop();
				out.push('</i>');
				continue;
			} else if (prefmtok(pc)) {
				formats.push('ITALIC');
				out.push('<i>');
				continue;
			}
		}

		if (c === '{' && cc === '{') {
			i++; /* skip cc */
			formats.push('CODE');
			commit_text();
			out.push('<code>');
			continue;
		}

		if (c === '\\' && formats[0] === 'CODE') {
			/*
			 * Allow for basic escaping within {{code}} blocks
			 * by using the backslash.
			 */
			text += cc;
			i++;
			continue;
		}

		if (c === '}' && cc === '}' && formats[0] === 'CODE') {
			i++; /* skip cc */
			formats.pop();
			commit_text();
			out.push('</code>');
			continue;
		}

		text += c;
	}

	commit_text();
	if (ps.ps_heading !== null) {
		out.push('</' + ps.ps_heading + '>');
	}
	return (out.join(''));
}

/*
 * Remove the leading {block} from a line, and return the remainder.
 */
function
eat_block(line)
{
	return (line.match(/^{[^}]*}?(.*)/)[1]);
}

/*
 * Creates two <div> blocks for displaying a JIRA markup panel, with the
 * appropriate CSS classes set. The consumer needs to handle the closing
 * tags, "</div></div>".
 */
function
format_panel_open(names)
{
	var html = '<div class="';
	var i;

	for (i = 0; i < names.length; ++i) {
		html += names[i] + ' ';
	}

	html += '"><div class="';

	for (i = 0; i < names.length; ++i) {
		html += names[i] + 'Content ';
	}

	html += '">';

	return (html);
}

function
format_markup_fallback(desc)
{
	var out = '';
	var lines = desc.split(/\r?\n/);

	var last_was_heading = false;
	var fmton = false;
	var newline_br = false;
	var parse_markup = true;
	var parser_state = {
		ps_list: false,
		ps_heading: null
	};
	var procneeded = true;
	var closing = null;

	for (var i = 0; i < lines.length; i++) {
		var line = lines[i];
		var lt_noformat = !!line.match(/^{noformat/);
		var lt_code = !!line.match(/^{code/);
		var lt_panel = !!line.match(/^{panel/);
		var lt_quote = !!line.match(/^{quote/);

		if (lt_noformat || lt_code || lt_panel || lt_quote) {
			procneeded = false;
			if (parser_state.ps_list) {
				parser_state.ps_list = false;
				out += '</ul>\n';
			}
			if (fmton) {
				mod_assert.string(closing, 'closing');
				parse_markup = true;
				out += closing;
				closing = null;
				line = '';
			} else if (lt_quote) {
				newline_br = true;
				parse_markup = true;
				out += '<blockquote>\n';
				closing = '</blockquote>';
				line = eat_block(line);
			} else if (lt_panel) {
				newline_br = false;
				parse_markup = true;
				out += format_panel_open(
				    [ 'panel' ]);
				out += '\n';
				closing = '</div></div>\n';
				line = eat_block(line);
			} else if (lt_noformat) {
				newline_br = false;
				parse_markup = false;
				out += format_panel_open(
				    [ 'preformatted', 'panel' ]);
				out += '<pre>\n';
				closing = '</pre></div></div>\n';
				line = eat_block(line);
			} else if (lt_code) {
				newline_br = false;
				parse_markup = false;
				out += format_panel_open(
				    [ 'code', 'panel' ]);
				out += '<pre>\n';
				closing = '</pre></div></div>\n';
				line = eat_block(line);
			}
			fmton = !fmton;
		}
		if (procneeded || line !== '') {
			if (parse_markup) {
				out += parse_jira_markup(line, parser_state);
			} else {
				out += mod_ent.encode(line);
			}
			if (fmton) {
				out += newline_br ? '<br>\n' : '\n';
			} else if (parser_state.ps_heading === null &&
				!last_was_heading) {
				out += '<br>\n';
			}
		}
		procneeded = true;
		last_was_heading = (parser_state.ps_heading !== null);
	}

	if (closing !== null) {
		out += closing;
	}

	return (out);
}


function
format_markup(desc)
{
	try {
		return (mod_jiramark.markupToHTML(desc, JIRA_OPS));
	} catch (e) {
		LOG.warn({
			errmsg: e.message,
			markup: desc
		}, 'failed to convert markup to HTML');
	}

	return (format_markup_fallback(desc));
}

function
format_issue_json(issue)
{
	var out = {
		id: issue.key,
		summary: issue.fields.summary,
		web_url: CONFIG.http_proto + '://smartos.org/bugview/' +
		    issue.key
	};

	return (JSON.stringify(out));
}

function
format_issue_title(issue)
{
	mod_assert.object(issue, 'issue');
	mod_assert.string(issue.key, 'issue.key');
	mod_assert.object(issue.fields, 'issue.fields');
	mod_assert.optionalString(issue.fields.summary,
	    'issue.fields.summary');

	var out = issue.key;

	if (issue.fields.summary) {
		out += ': ' + issue.fields.summary;
	}

	return (out);
}

function
format_issue(opts, callback)
{
	mod_assert.object(opts, 'opts');
	mod_assert.string(opts.format, 'opts.format');
	mod_assert.object(opts.issue, 'opts.issue');
	mod_assert.object(opts.log, 'opts.log');
	mod_assert.func(callback, 'callback');

	var remotelinks;

	var issue = opts.issue;
	var log = opts.log;

	/*
	 * First, we perform a few additional requests to fill out more
	 * information about linked issues.  In particular, we want to know
	 * if they have been marked "public" or not.
	 */
	var other_issues = {};
	mod_vasync.waterfall([ function lookup_linked_issues(next) {
		if (!issue.fields.issuelinks) {
			setImmediate(next);
			return;
		}

		/*
		 * Assemble a list of all of the unique issues we need to
		 * fetch.  There may be multiple links that refer to the same
		 * issue; e.g., this issue might be both "related to" and
		 * "duplicate of" the same other issue.
		 */
		issue.fields.issuelinks.forEach(function (l) {
			if (l.outwardIssue) {
				other_issues[l.outwardIssue.key] = null;
			}

			if (l.inwardIssue) {
				other_issues[l.inwardIssue.key] = null;
			}
		});

		mod_vasync.forEachParallel({ inputs: Object.keys(other_issues),
		    func: function lookup_linked_issue_one(key, done) {
			BACKEND.be_issue_get(key, function (err, other) {
				if (err) {
					/*
					 * In this particular case, we ignore
					 * the failure to retrieve a related
					 * issue from JIRA.  It's almost
					 * certainly better to be able to
					 * give information about the bug
					 * itself, even if we cannot fetch
					 * all of the Related Issues.
					 */
					log.warn(err, 'could not fetch ' +
					    'related issue ' + key);
					done();
					return;
				}

				/*
				 * Include only issues marked "public".
				 */
				if (UNRESTRICTED ||
				    other.fields.labels.indexOf(
				    CONFIG.label) !== -1) {
					other_issues[key] = other;
				} else {
					log.debug('%s relates to issue %s, ' +
					    'which is not marked public',
					    issue.key, key);
				}

				done();
			});
		} }, function (err) {
			next(err);
		});
	}, function get_remote_links(next) {
		/*
		 * A ticket can have "remote links" attached to it, which are
		 * URLs to resources outside of JIRA. We primarily use these to
		 * link to code reviews, but they can also be to relevant bugs
		 * on other sites, such as illumos.org.
		 */
		BACKEND.be_remotelink_get(issue.id, function (err, links) {
			if (err) {
				next(err);
				return;
			}

			mod_assert.array(links, 'links');

			/*
			 * We filter out domains that haven't been explicitly
			 * allowed, in case there are any tickets floating
			 * around with links to signed Manta URLs.
			 */
			remotelinks = links.filter(function (rl) {
				var parsed = mod_url.parse(rl.object.url);
				var domain = parsed.hostname;

				if (domain === null) {
					return (false);
				}

				return (ALLOWED_DOMAINS.indexOf(domain) !== -1);
			});

			next(null);
		});
	}, function do_format(next) {
		var fi = format_issue_assemble(issue, remotelinks,
		    other_issues);

		if (opts.format !== 'html') {
			next(null, JSON.stringify(fi, null, 4));
			return;
		}

		next(null, format_issue_finalise(fi.issue, fi.remotelinks));
	} ], callback);
}

/*
 * Accepts "heading", a string to be used as a level two heading; and "table",
 * an array of objects with a "name" and "value" property.  Returns either an
 * empty string (if "table" contains no entries), or a heading and HTML table
 * with a name (in bold) and a value cell on each row.
 */
function
render_table(heading, table)
{
	mod_assert.string(heading, 'heading');
	mod_assert.arrayOfObject(table, 'table');

	if (table.length === 0) {
		return ('');
	}

	var out = [
		'<h2>' + heading + '</h2>',
		'<table>'
	];

	table.forEach(function (row) {
		out.push('<tr><th><b>' + row.name + '</b></th>' +
		    '<td>' + row.value + '</td></tr>');
	});

	out.push('</table>');

	return (out.join('\n') + '\n');
}

/*
 * Accepts "issue", an issue from the JIRA backend; "type", the name of a field
 * (e.g., "creator"); "label", the heading name to use for the table row; and
 * "rows", a table array for use with render_table().  If we can read the named
 * field from the table, we'll render it for display and append it to the
 * table; otherwise, "rows" is unaltered.
 */
function
extract_people_field(issue, type, label, rows)
{
	var f;

	if (!(f = issue.fields[type])) {
		return;
	}

	var val = null;
	if (f.displayName) {
		val = f.displayName;
	}

	if (val === null || val === '') {
		return;
	}

	rows.push({ name: label + ':', value: val });
}

/*
 * Assemble an object which contains only the sanitised public data used to
 * produce either the rendered HTML or JSON API view of the issue.
 */
function
format_issue_assemble(issue, remotelinks, other_issues)
{
	mod_assert.object(issue, 'issue');
	mod_assert.object(other_issues, 'other_issues');
	mod_assert.arrayOfObject(remotelinks, 'remotelinks');

	var out = {
		id: issue.id,
		key: issue.key,
		fields: {
			summary: issue.fields.summary
		}
	};

	function copy_obj(fname) {
		if (!issue.fields[fname]) {
			return;
		}

		var t = {};
		ISSUE_OBJECT_KEYS.forEach(function (k) {
			if (issue.fields[fname][k]) {
				t[k] = issue.fields[fname][k];
			}
		});

		out.fields[fname] = t;
	}

	function copy_simple(fname) {
		if (issue.fields[fname]) {
			out.fields[fname] = issue.fields[fname];
		}
	}

	copy_obj('issuetype');
	copy_obj('priority');
	copy_obj('status');

	copy_simple('created');
	copy_simple('updated');

	copy_obj('creator');
	copy_obj('reporter');
	copy_obj('assignee');

	copy_obj('resolution');
	copy_simple('resolutiondate');

	if (issue.fields.fixVersions) {
		out.fields.fixVersions = issue.fields.fixVersions.map(
		    function (fv) {
			var t = {};

			RELEASE_OBJECT_KEYS.forEach(function (k) {
				if (fv[k]) {
					t[k] = fv[k];
				}
			});

			return (t);
		});
	}

	if (issue.fields.issuelinks) {
		var links = [];

		for (var i = 0; i < issue.fields.issuelinks.length; i++) {
			var il = issue.fields.issuelinks[i];
			var ilo = {
				id: il.id,
				type: {
					id: il.type.id,
					name: il.type.name,
					inward: il.type.inward,
					outward: il.type.outward
				}
			};
			var push = false;

			if (il.outwardIssue &&
			    allow_issue(il.outwardIssue.key, other_issues)) {
				push = true;
				ilo.outwardIssue = {
					id: il.outwardIssue.id,
					key: il.outwardIssue.key,
					fields: {
						summary: il.outwardIssue
						    .fields.summary
					}
				};
			}

			if (il.inwardIssue &&
			    allow_issue(il.inwardIssue.key, other_issues)) {
				push = true;
				ilo.inwardIssue = {
					id: il.inwardIssue.id,
					key: il.inwardIssue.key,
					fields: {
						summary: il.inwardIssue
						    .fields.summary
					}
				};
			}

			if (push) {
				links.push(ilo);
			}
		}

		out.fields.issuelinks = links;
	}

	out.fields.labels = issue.fields.labels.filter(is_allowed_label);

	copy_simple('description');

	function copy_author(fname, cfrom, cto) {
		if (!cfrom[fname]) {
			return;
		}

		cto[fname] = {
			name: cfrom[fname].name,
			key: cfrom[fname].key,
			emailAddress: cfrom[fname].emailAddress,
			displayName: cfrom[fname].displayName
		};
	}

	if (issue.fields.comment) {
		var cout = { maxResults: 0, total: 0, startAt: 0,
		    comments: [] };
		var c = issue.fields.comment;

		if (c.maxResults !== c.total) {
			LOG.error({
				issue: issue.key,
				total: c.total,
				maxResults: c.maxResults
			}, 'comment maxResults and total not equal for issue');
		}

		for (i = 0; i < c.comments.length; i++) {
			var com = c.comments[i];

			if (com.visibility) {
				/*
				 * For now, skip comments with _any_
				 * visibility rules.
				 */
				continue;
			}

			var outcom = {
				id: com.id,
				created: com.created,
				updated: com.updated,
				body: com.body
			};

			copy_author('author', com, outcom);
			copy_author('updateAuthor', com, outcom);

			cout.comments.push(outcom);
			cout.maxResults++;
			cout.total++;
		}

		out.fields.comment = cout;
	}

	return ({
		issue: out,
		remotelinks: remotelinks.map(function (rl) {
			return ({
				id: rl.id,
				object: {
					url: rl.object.url,
					title: rl.object.title
				}
			});
		})
	});
}

function
format_issue_finalise(issue, remotelinks)
{
	mod_assert.object(issue, 'issue');
	mod_assert.arrayOfObject(remotelinks, 'remotelinks');

	var i;
	var out = '<h1>' + issue.key + ': ' + issue.fields.summary + '</h1>\n';

	var details = [];
	if (issue.fields.issuetype && issue.fields.issuetype.name) {
		details.push({ name: 'Issue Type:',
		    value: issue.fields.issuetype.name });
	}
	if (issue.fields.priority && issue.fields.priority.name) {
		details.push({ name: 'Priority:',
		    value: issue.fields.priority.name });
	}
	if (issue.fields.status && issue.fields.status.name) {
		details.push({ name: 'Status:',
		    value: issue.fields.status.name });
	}
	if (issue.fields.created) {
		details.push({ name: 'Created at:',
		    value: new Date(issue.fields.created).toISOString() });
	}
	if (issue.fields.updated) {
		details.push({ name: 'Updated at:',
		    value: new Date(issue.fields.updated).toISOString() });
	}
	out += render_table('Details', details);

	var people = [];
	extract_people_field(issue, 'creator', 'Created by', people);
	extract_people_field(issue, 'reporter', 'Reported by', people);
	extract_people_field(issue, 'assignee', 'Assigned to', people);
	out += render_table('People', people);

	if (issue.fields.resolution) {
		var rd = new Date(issue.fields.resolutiondate);

		out += '<h2>Resolution</h2>\n';
		out += '<p><b>' + issue.fields.resolution.name + ':</b> ' +
		    issue.fields.resolution.description + '<br>\n';
		out += '(Resolution Date: ' + rd.toISOString() + ')</p>\n';
	}

	if (issue.fields.fixVersions && issue.fields.fixVersions.length > 0) {
		out += '<h2>Fix Versions</h2>\n';
		for (i = 0; i < issue.fields.fixVersions.length; i++) {
			var fv = issue.fields.fixVersions[i];

			out += '<p><b>' + fv.name + '</b> (Release Date: ' +
			    fv.releaseDate + ')</p>\n';
		}
	}

	if (issue.fields.issuelinks) {
		var links = [];

		for (i = 0; i < issue.fields.issuelinks.length; i++) {
			var il = issue.fields.issuelinks[i];

			if (il.outwardIssue) {
				links.push('<li>' + il.type.outward +
				    ' <a href="' + il.outwardIssue.key + '">' +
				    il.outwardIssue.key + '</a> ' +
				    il.outwardIssue.fields.summary +
				    '</li>');
			}

			if (il.inwardIssue) {
				links.push('<li>' + il.type.inward +
				    ' <a href="' + il.inwardIssue.key + '">' +
				    il.inwardIssue.key + '</a> ' +
				    il.inwardIssue.fields.summary +
				    '</li>');
			}
		}

		if (links.length > 0) {
			out += '<h2>Related Issues</h2>\n';
			out += '<p><ul>' + links.join('\n') + '</ul></p>\n';
		}
	}

	if (remotelinks.length > 0) {
		out += '<h2>Related Links</h2>\n';
		out += '<p><ul>\n';

		for (i = 0; i < remotelinks.length; i++) {
			var rl = remotelinks[i].object;

			out += '<li>';
			out += format_remote_link(rl.url, rl.title);
			out += '</li>\n';
		}

		out += '</ul></p>\n';
	}

	var labellinks = issue.fields.labels.map(function label_link(label) {
		return make_label_link(label, false);
	});
	if (labellinks.length > 0) {
		out += '<h2>Labels</h2>\n';
		out += '<p>' + labellinks.join(', ') + '</p>\n';
	}

	if (issue.fields.description) {
		out += '<h2>Description</h2>\n';
		out += '<div>';
		out += format_markup(issue.fields.description);
		out += '</div>\n';
	}

	if (issue.fields.comment) {
		out += '<h2>Comments</h2>\n';

		var c = issue.fields.comment;

		if (c.maxResults !== c.total) {
			LOG.error({
				issue: issue.key,
				total: c.total,
				maxResults: c.maxResults
			}, 'comment maxResults and total not equal for issue');
		}

		for (i = 0; i < c.comments.length; i++) {
			var com = c.comments[i];

			var cdtc = new Date(com.created);

			if (i !== 0) {
				out += '<hr>\n';
			}

			out += '<div>\n';
			out += '<b>';
			out += '<a name="comment-' + i + '"></a>';
			out += 'Comment by ' + com.author.displayName;
			out += '<br>\n';
			out += 'Created at ' + cdtc.toISOString();
			out += '<br>\n';
			if (com.updated && com.updated !== com.created) {
				out += 'Updated at ' +
				    new Date(com.updated).toISOString() +
				    '<br>\n';
			}
			out += '</b>';
			out += format_markup(com.body);
			out += '</div>\n';
		}
	}

	return (out);
}


/*
 * Create a new anchor tag, with several important traits:
 *
 * - Open in a new, blank context (target="_blank"). This is usually
 *   a new tab in most browsers.
 * - Prevent that new tab from getting referral information ("noreferrer")
 *   about who opened it, and from controlling the bugview page via the
 *   window.opener API ("noopener").
 */
function
format_remote_link(link, text)
{
	var anchor = '<a rel="noopener noreferrer" target="_blank" href="' +
	    fix_url(link) + '">' + text + '</a>';

	return (anchor);
}

/*
 * Any label that is passed is a whitelisted label and as such can be assumed to
 * be safe. Famous last words.
 */
function
make_label_link(label, bold)
{
	if (bold) {
		label = '<b>' + label + '</b>';
	}
	return '<a href="/bugview/label/' + label + '">' + label + '</a>';
}

/*
 * Main:
 */

function
main() {
	read_templates(LOG);

	if (process.env.UNRESTRICTED === 'yes') {
		LOG.warn('unrestricted operation enabled');
		UNRESTRICTED = true;
	}

	if (process.env.LOCAL_STORE) {
		BACKEND = lib_backend_files.files_backend_init(CONFIG, LOG);
	} else {
		BACKEND = lib_backend_jira.jira_backend_init(CONFIG, LOG);
	}

	create_http_server(LOG, function (s) {
		SERVER = s;
	});
}

main();
