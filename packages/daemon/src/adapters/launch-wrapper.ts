// Credential-fd launch wrapper: builds ONE line to type into a tmux pane that opens credential
// FILES onto numbered file descriptors for the harness it execs. A token therefore reaches a
// harness inside tmux without being typed into the pane, written to the tmux environment, or
// placed in argv: only the credential file's PATH appears in the line (which lands in the pane
// shell's history; it holds no secret). An fd held by the daemon itself would not survive into a
// pane, which is why the open happens in the pane's own process tree.
//
// Limits (stated, not overclaimed): an fd inherited by the harness is also inherited by the
// harness's own child processes, and an env value such as GROK_AUTH_PROVIDER_COMMAND is visible to
// the harness's tools. Both run as the same Unix user, who can read the token file anyway.
//
// Shape: `/bin/sh -c '<FIXED_SCRIPT>' openrig-launch <operands...>`. FIXED_SCRIPT is a constant,
// never built from caller data, has no newline, no single quote, no backslash, and never uses
// `eval`. Operands are count-prefixed records, each element a positional argument:
//   E <K=V>                 export a non-secret env assignment
//   B <n> <argv1..argvn>    run a pre-launch step with </dev/null (non-zero exit aborts)
//   A <flag> <path>         append `flag <file contents>` to the harness argv
//   P <path>                append one positional argument read from a file
//   F <fd> <path>           open <path> read-only onto <fd> (3..9)
//   --                      the harness argv follows
// Records run in that order: env, before steps (in a subshell, WITHOUT the credential fds, which
// are opened only afterwards), argFiles, fd opens, then `exec env <harness argv> <argFile args>`
// in the top-level sh so the pane's foreground process becomes the harness itself (no sh parent
// remains for the at-shell guard or a readiness probe to see).
//
// So the line never contains a newline, every operand is escaped for printf's %b (backslash
// doubled, control characters as \0ooo) and decoded once by the script before the walk.

import { shellQuote } from "./shell-quote.js";

export interface CredentialFd {
  /** 3..9 only. */
  fd: number;
  path: string;
}

export interface WrappedLaunch {
  /** Harness argv; argv[0] is the binary. */
  argv: string[];
  /** NON-secret env (names ^[A-Z_][A-Z0-9_]*$). */
  env?: Record<string, string>;
  /** Credential files opened read-only onto these fds for the final exec only. */
  fds?: CredentialFd[];
  /** argv lists run first with </dev/null; a non-zero exit aborts the launch. */
  before?: string[][];
  /** Appends `flag <file contents>` to argv at launch. */
  argFiles?: { flag: string; path: string }[];
  /** Appends the file contents as the final positional argv element. */
  promptFile?: string;
}

const FD_OPEN_CASES = [3, 4, 5, 6, 7, 8, 9].map((n) => `${n}) exec ${n}<"$3";;`).join(" ");

export const FIXED_SCRIPT = [
  'for a in "$@"; do v=$(printf "%bx" "$1"); set -- "$@" "${v%x}"; shift; done;',
  'while [ "$#" -gt 0 ]; do case $1 in',
  'E) export "$2"; shift 2;;',
  'B) n=$2; (shift 2; t=$#; i=0; while [ "$i" -lt "$t" ]; do i=$((i+1)); if [ "$i" -le "$n" ]; then set -- "$@" "$1"; fi; shift; done; exec "$@") </dev/null || { echo "openrig-launch: a pre-launch step failed; the harness was not started" >&2; exit 1; }; shift 2; shift "$n";;',
  'A) v=$(cat <"$3") || { echo "openrig-launch: cannot read the argument file for $2" >&2; exit 1; }; set -- "$@" "$2" "$v"; shift 3;;',
  'P) v=$(cat <"$2") || { echo "openrig-launch: cannot read the prompt file" >&2; exit 1; }; set -- "$@" "$v"; shift 2;;',
  `F) if ! (: <"$3") 2>/dev/null; then echo "openrig-launch: cannot open the credential file for fd $2" >&2; exit 1; fi; case $2 in ${FD_OPEN_CASES} *) echo "openrig-launch: fd $2 is out of range" >&2; exit 1;; esac; shift 3;;`,
  "--) shift; break;;",
  '*) echo "openrig-launch: malformed launch record" >&2; exit 1;;',
  "esac; done;",
  'exec env "$@"',
].join(" ");

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/** Escape for printf %b: backslash doubled, every control character as \0ooo. */
function encodeOperand(value: string): string {
  if (value.includes("\0")) throw new Error("launch wrapper: an operand contains a NUL byte");
  return value.replace(/[\\\x00-\x1f\x7f]/g, (c) =>
    c === "\\" ? "\\\\" : "\\0" + c.charCodeAt(0).toString(8).padStart(3, "0"),
  );
}

function requireAbsolute(path: string, what: string): void {
  if (!path.startsWith("/")) throw new Error(`launch wrapper: ${what} path must be absolute`);
}

export function buildWrappedLaunch(w: WrappedLaunch): string {
  if (!w.argv || w.argv.length === 0) throw new Error("launch wrapper: argv must not be empty");
  const bin = w.argv[0]!;
  if (bin.length === 0 || bin.includes("=") || bin.startsWith("-")) {
    throw new Error("launch wrapper: argv[0] must be a binary name (no '=', no leading '-')");
  }

  const operands: string[] = [];
  for (const [name, value] of Object.entries(w.env ?? {})) {
    if (!ENV_NAME_RE.test(name)) throw new Error(`launch wrapper: invalid env name (must match ${ENV_NAME_RE.source})`);
    operands.push("E", `${name}=${value}`);
  }
  for (const step of w.before ?? []) {
    if (step.length === 0) throw new Error("launch wrapper: a before step argv must not be empty");
    operands.push("B", String(step.length), ...step);
  }
  for (const file of w.argFiles ?? []) {
    requireAbsolute(file.path, "argFile");
    operands.push("A", file.flag, file.path);
  }
  if (w.promptFile !== undefined) {
    requireAbsolute(w.promptFile, "promptFile");
    operands.push("P", w.promptFile);
  }
  const seen = new Set<number>();
  for (const cred of w.fds ?? []) {
    if (!Number.isInteger(cred.fd) || cred.fd < 3 || cred.fd > 9) {
      throw new Error(`launch wrapper: credential fd ${cred.fd} is outside 3..9`);
    }
    if (seen.has(cred.fd)) throw new Error(`launch wrapper: duplicate credential fd ${cred.fd}`);
    seen.add(cred.fd);
    requireAbsolute(cred.path, "credential file");
    operands.push("F", String(cred.fd), cred.path);
  }
  operands.push("--", ...w.argv);

  return `/bin/sh -c '${FIXED_SCRIPT}' openrig-launch ${operands.map((o) => shellQuote(encodeOperand(o))).join(" ")}`;
}
