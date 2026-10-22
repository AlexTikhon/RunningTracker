import fs from 'fs';

// The proxy's error-log boundary (ADR-0062). nginx's stderr is a private pipe and this program is its only reader.
// Nothing it reads is copied out: each line it writes is rebuilt from allow-listed fields, which are the entry time,
// level, process, connection number, a fixed event name and numeric or identifier details. The request line, the
// upstream URI, host, referrer and all message text nginx adds are dropped, because they can carry the OIDC
// callback's one-time code and state. A record it cannot classify is reported by size only.
//
// It runs under njs's QuickJS engine in the proxy image (the default njs engine never frees memory) and under Node
// in the unit tests, so it uses only what both provide: Buffer, fs.readSync and fs.writeSync.

// nginx cuts an entry at 2048 bytes (NGX_MAX_ERROR_STR). Anything longer did not come from its logger.
export const MAX_RECORD_BYTES = 4096;
const READ_BYTES = 4096;

const LEVELS = 'emerg|alert|crit|error|warn|notice|info|debug';
const ENTRY = new RegExp(`^(\\d{4}/\\d\\d/\\d\\d \\d\\d:\\d\\d:\\d\\d) \\[(${LEVELS})\\] (\\d{1,10})#(\\d{1,10}): (?:\\*(\\d{1,20}) )?`);
// What nginx writes to the console before its logs are open.
const CONSOLE = new RegExp(`^nginx: \\[(${LEVELS})\\] `);

// The action nginx appends as "while <action>,"; only these fixed phrases become a phase.
const PHASES = [
  ['connecting to upstream', 'upstream_connect'],
  ['sending request to upstream', 'upstream_send'],
  ['reading response header from upstream', 'upstream_header'],
  ['reading upstream', 'upstream_body'],
  ['sending to client', 'client_send'],
  ['reading client request body', 'client_body'],
  ['reading client request line', 'client_request_line'],
  ['reading client request headers', 'client_headers'],
  ['reading client pipelined request line', 'client_request_line'],
  ['SSL handshaking', 'tls_handshake'],
  ['waiting for request', 'idle'],
  ['processing HTTP/2 connection', 'http2'],
  ['closing request', 'closing'],
];

// [pattern, event, names of the captured details]. Every capture group admits only digits or an identifier, and
// nothing outside a capture group is ever written.
const REQUEST_RULES = [
  [/^client intended to send too large (?:chunked )?body: (\d{1,20})/, 'request_body_too_large', ['bytes']],
  [/^connect\(\) failed \((\d{1,4}): /, 'upstream_connect_failed', ['errno']],
  [/^upstream timed out \((\d{1,4}): /, 'upstream_timeout', ['errno']],
  [/^upstream prematurely closed connection/, 'upstream_closed_early', []],
  [/^no live upstreams/, 'upstream_unavailable', []],
  [/^upstream sent too big header/, 'upstream_header_too_big', []],
  [/^upstream sent /, 'upstream_invalid_response', []],
  [/^upstream server temporarily disabled/, 'upstream_disabled', []],
  // The zone name is not captured: the profile has one zone, and a quoted name is text.
  [/^limiting requests, excess: /, 'request_rate_limited', []],
  [/^delaying request, excess: /, 'request_rate_delayed', []],
  [/^limiting connections by zone /, 'connection_limited', []],
  [/^an upstream response is buffered to a temporary file/, 'upstream_response_buffered_to_disk', []],
  [/^a client request body is buffered to a temporary file/, 'request_body_buffered_to_disk', []],
  [/^client timed out \((\d{1,4}): /, 'client_timeout', ['errno']],
  [/^client prematurely closed connection/, 'client_closed_early', []],
  [/^client closed (?:prematurely )?connection/, 'client_closed', []],
  [/^client sent /, 'client_bad_request', []],
  [/^client /, 'client_protocol_error', []],
  [/^SSL_do_handshake\(\) failed/, 'tls_handshake_failed', []],
  [/^SSL_\w{1,16}\(\) failed/, 'tls_io_failed', []],
  [/^(?:recv|recvmsg|readv|send|sendmsg|writev|sendfile)\(\) failed \((\d{1,4}): /, 'io_failed', ['errno']],
  [/^open\(\) ".*" failed \((\d{1,4}): /, 'file_open_failed', ['errno']],
  [/^".*" is not found \((\d{1,4}): /, 'file_not_found', ['errno']],
  [/^directory index of ".*" is forbidden/, 'directory_index_forbidden', []],
  [/^rewrite or internal redirection cycle/, 'internal_redirect_cycle', []],
];

// Entries without a connection: process lifecycle and configuration.
const PROCESS_RULES = [
  [/^signal (\d{1,3}) \((SIG[A-Z0-9]{1,10})\) received/, 'signal_received', ['number', 'signal']],
  [/^worker process (\d{1,10}) exited on signal (\d{1,3})/, 'worker_crashed', ['worker', 'signal']],
  [/^worker process (\d{1,10}) exited with (?:fatal )?code (\d{1,3})/, 'worker_exited', ['worker', 'code']],
  [/^bind\(\) to \S{1,64} failed \((\d{1,4}): /, 'listen_failed', ['errno']],
  [/^accept4?\(\) failed \((\d{1,4}): /, 'accept_failed', ['errno']],
  [/^(\d{1,10}) worker_connections are not enough/, 'worker_connections_exhausted', ['limit']],
  // Only the image's own configuration files are named.
  [
    / in \/etc\/nginx\/(nginx\.conf|mime\.types|conf\.d\/site\.conf|snippets\/security-headers\.conf):(\d{1,6})$/,
    'configuration_error',
    ['file', 'line'],
  ],
  [/ in \/etc\/nginx\/\S{1,128}:(\d{1,6})$/, 'configuration_error', ['line']],
  [/^could not build /, 'configuration_warning', []],
  [/^the "[a-z0-9_]{1,64}" directive is deprecated/, 'configuration_warning', []],
  [/^using the "[a-z0-9_]{1,16}" event method$/, 'event_method', []],
  [/^start worker processes$/, 'workers_starting', []],
  [/^start worker process (\d{1,10})$/, 'worker_started', ['worker']],
  [/^gracefully shutting down$/, 'shutting_down', []],
  [/^reconfiguring$/, 'reconfiguring', []],
  [/^reopening logs$/, 'reopening_logs', []],
  [/^exiting$/, 'exiting', []],
  [/^exit$/, 'exited', []],
];

function phaseOf(message) {
  const match = / while ([A-Za-z0-9/ ]{1,64}?)(?:,|$)/.exec(message);
  if (match === null) return undefined;
  for (let index = 0; index < PHASES.length; index += 1) {
    if (PHASES[index][0] === match[1]) return PHASES[index][1];
  }
  return undefined;
}

function classify(rules, message) {
  for (let index = 0; index < rules.length; index += 1) {
    const [pattern, event, names] = rules[index];
    const match = pattern.exec(message);
    if (match === null) continue;
    let details = '';
    for (let field = 0; field < names.length; field += 1) details += ` ${names[field]}=${match[field + 1]}`;
    return { details, event };
  }
  return { details: '', event: 'unclassified' };
}

// One record (a line without its newline) to one output line.
export function sanitizeRecord(text, byteLength) {
  let match = ENTRY.exec(text);
  if (match !== null) {
    const connection = match[5];
    const message = text.slice(match[0].length);
    const head = `${match[1]} [${match[2]}] ${match[3]}#${match[4]}: `;
    if (connection === undefined) {
      const { details, event } = classify(PROCESS_RULES, message);
      return `${head}event=${event}${details}`;
    }
    const { details, event } = classify(REQUEST_RULES, message);
    const phase = phaseOf(message);
    const side = phase !== undefined && phase.startsWith('upstream_') ? 'upstream_io_failed' : 'client_io_failed';
    return `${head}*${connection} event=${event === 'io_failed' ? side : event}${details}${phase === undefined ? '' : ` phase=${phase}`}`;
  }
  match = CONSOLE.exec(text);
  if (match !== null) {
    const { details, event } = classify(PROCESS_RULES, text.slice(match[0].length));
    return `nginx: [${match[1]}] event=${event}${details}`;
  }
  return `nginx-error-log: event=unrecognized_record bytes=${byteLength}`;
}

// Splits a byte stream into records of at most MAX_RECORD_BYTES and calls `emit` with one output line per record.
// Memory is two fixed buffers whatever the input: a longer record is dropped as it arrives and reported once.
export function createBoundary(emit, sanitize = sanitizeRecord) {
  const pending = Buffer.alloc(MAX_RECORD_BYTES);
  let length = 0;
  let overlong = 0;

  const complete = () => {
    if (overlong > 0) {
      emit(`nginx-error-log: event=overlong_record bytes=${overlong}`);
    } else if (length > 0) {
      if (pending[length - 1] === 13) length -= 1;
      let line;
      try {
        line = sanitize(pending.toString('utf8', 0, length), length);
      } catch {
        line = `nginx-error-log: event=sanitizer_rejected_record bytes=${length}`;
      }
      emit(line);
    }
    length = 0;
    overlong = 0;
  };

  return {
    push(chunk, size) {
      let start = 0;
      while (start < size) {
        let newline = chunk.indexOf(10, start);
        if (newline >= size) newline = -1;
        const stop = newline < 0 ? size : newline;
        if (overlong > 0) {
          overlong += stop - start;
        } else if (length + stop - start > MAX_RECORD_BYTES) {
          overlong = length + stop - start;
          length = 0;
        } else {
          chunk.copy(pending, length, start, stop);
          length += stop - start;
        }
        if (newline < 0) return;
        complete();
        start = newline + 1;
      }
    },
    end() {
      if (overlong > 0) emit(`nginx-error-log: event=overlong_record bytes=${overlong}`);
      else if (length > 0) emit(`nginx-error-log: event=truncated_record bytes=${length}`);
      length = 0;
      overlong = 0;
    },
  };
}

function writeAll(fd, text) {
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
}

// Reads `input` to its end. A failed write throws: the caller's exit status reports it, and the entrypoint stops
// nginx rather than let anything else carry its log.
export function run(input = 0, output = 1) {
  const chunk = Buffer.alloc(READ_BYTES);
  let out = '';
  const boundary = createBoundary((line) => {
    out += `${line}\n`;
  });
  for (;;) {
    const size = fs.readSync(input, chunk, 0, READ_BYTES, null);
    if (size === 0) break;
    boundary.push(chunk, size);
    if (out.length > 0) {
      writeAll(output, out);
      out = '';
    }
  }
  boundary.end();
  if (out.length > 0) writeAll(output, out);
}

if (typeof njs === 'object') run();
