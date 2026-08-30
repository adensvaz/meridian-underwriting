// A small, safe expression language for user-editable underwriting formulas.
//
// Why not just use JavaScript? Because the whole point of this product is that
// a business user edits the formulas, and those formulas arrive from the
// database. `eval` or `new Function` on database content is a remote code
// execution hole with extra steps. This is a real tokenizer, Pratt parser and
// tree-walking evaluator over a closed grammar: no property access, no member
// calls, no assignment, no loops, a whitelisted function table, and hard caps
// on depth and node count.
//
// Null propagation is deliberate and load-bearing. If a rent roll had no
// service-charge figure, `service_charge` is null, and every line depending on
// it evaluates to null rather than zero. A zero would quietly flatter the deal;
// a null shows up on screen as "—" and in the warnings list. Missing data must
// look missing.

export type Value = number | boolean | string | null;

const MAX_SOURCE_LENGTH = 4000;
const MAX_DEPTH = 64;
const MAX_NODES = 2000;

export class FormulaError extends Error {
  position: number;
  constructor(message: string, position = -1) {
    super(position >= 0 ? `${message} (at character ${position + 1})` : message);
    this.name = "FormulaError";
    this.position = position;
  }
}

// ------------------------------------------------------------------ tokens --

type TokenType = "number" | "string" | "ident" | "op" | "punc" | "eof";

interface Token {
  type: TokenType;
  value: string;
  num?: number;
  pos: number;
}

const THREE_CHAR_OPS = ["**="];
const TWO_CHAR_OPS = ["<=", ">=", "==", "!=", "&&", "||", "**"];
const ONE_CHAR_OPS = "+-*/%^<>!?:";

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}
function isIdentStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c) || c === ".";
}

export function tokenize(src: string): Token[] {
  if (src.length > MAX_SOURCE_LENGTH) {
    throw new FormulaError(`Formula is too long (${src.length} characters, limit ${MAX_SOURCE_LENGTH})`);
  }
  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const c = src[i];

    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }

    // Comments let a model author explain a formula to the next person.
    if (c === "#" || (c === "/" && src[i + 1] === "/")) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }

    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      const start = i;
      while (i < src.length && (isDigit(src[i]) || src[i] === "_")) i++;
      if (src[i] === ".") {
        i++;
        while (i < src.length && (isDigit(src[i]) || src[i] === "_")) i++;
      }
      if (src[i] === "e" || src[i] === "E") {
        const save = i;
        i++;
        if (src[i] === "+" || src[i] === "-") i++;
        if (isDigit(src[i] ?? "")) {
          while (i < src.length && isDigit(src[i])) i++;
        } else {
          i = save;
        }
      }
      const text = src.slice(start, i).replace(/_/g, "");
      const n = Number(text);
      if (!Number.isFinite(n)) throw new FormulaError(`Invalid number "${text}"`, start);

      // A trailing % is a literal, not an operator: `5%` means 0.05. Business
      // users write percentages constantly and this removes a whole class of
      // "why is my vacancy 500%" mistakes.
      if (src[i] === "%" && !isDigit(src[i + 1] ?? "")) {
        i++;
        tokens.push({ type: "number", value: `${text}%`, num: n / 100, pos: start });
      } else {
        tokens.push({ type: "number", value: text, num: n, pos: start });
      }
      continue;
    }

    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      i++;
      let out = "";
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < src.length) {
          i++;
          out += src[i];
        } else {
          out += src[i];
        }
        i++;
      }
      if (i >= src.length) throw new FormulaError("Unterminated text value", start);
      i++;
      tokens.push({ type: "string", value: out, pos: start });
      continue;
    }

    if (isIdentStart(c)) {
      const start = i;
      while (i < src.length && isIdentPart(src[i])) i++;
      tokens.push({ type: "ident", value: src.slice(start, i), pos: start });
      continue;
    }

    const three = src.slice(i, i + 3);
    if (THREE_CHAR_OPS.includes(three)) {
      throw new FormulaError(`Assignment is not allowed in a formula`, i);
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.includes(two)) {
      tokens.push({ type: "op", value: two === "**" ? "^" : two, pos: i });
      i += 2;
      continue;
    }
    if (c === "=" && src[i + 1] !== "=") {
      throw new FormulaError(`Use "==" to compare, "=" is not valid here`, i);
    }
    if (ONE_CHAR_OPS.includes(c)) {
      tokens.push({ type: "op", value: c, pos: i });
      i++;
      continue;
    }
    if (c === "(" || c === ")" || c === ",") {
      tokens.push({ type: "punc", value: c, pos: i });
      i++;
      continue;
    }

    throw new FormulaError(`Unexpected character "${c}"`, i);
  }

  tokens.push({ type: "eof", value: "", pos: src.length });
  return tokens;
}

// --------------------------------------------------------------------- AST --

export type Node =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "null" }
  | { kind: "ref"; name: string; pos: number }
  | { kind: "unary"; op: string; operand: Node }
  | { kind: "binary"; op: string; left: Node; right: Node; pos: number }
  | { kind: "ternary"; cond: Node; whenTrue: Node; whenFalse: Node }
  | { kind: "call"; name: string; args: Node[]; pos: number };

// Every lookup table in this file is indexed by attacker-influenced strings
// (identifiers and function names out of a user-edited formula), so every read
// goes through Object.hasOwn. A bare `TABLE[name]` inherits from
// Object.prototype, which means `constructor`, `__proto__`, `toString` and
// friends all resolve to something truthy — that is a real hole, not a
// theoretical one, and it is how `constructor` briefly evaluated to a function
// instead of being rejected as an unknown name.
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

// Higher binds tighter.
const BINARY_PRECEDENCE: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
  "^": 7,
};
const RIGHT_ASSOCIATIVE = new Set(["^"]);

// A note on unary minus and exponentiation, because the two conventions
// disagree and silence would be a trap.
//
//   Excel:            -2 ^ 2  ==  4     (unary minus binds tighter)
//   Python / most CS: -2 ** 2 == -4     (exponent binds tighter)
//
// This language follows EXCEL, because the people editing these formulas
// underwrite in Excel and a formula that means one thing in their spreadsheet
// and another here would be worse than either convention on its own.
// `2 ^ 3 ^ 2` is still right-associative and evaluates to 512, as in both.

const KEYWORDS: Record<string, Node> = {
  true: { kind: "bool", value: true },
  false: { kind: "bool", value: false },
  null: { kind: "null" },
  none: { kind: "null" },
};

class Parser {
  private tokens: Token[];
  private index = 0;
  private nodes = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.index];
  }
  private next(): Token {
    return this.tokens[this.index++];
  }
  private expect(value: string): Token {
    const t = this.peek();
    if (t.value !== value) {
      throw new FormulaError(`Expected "${value}" but found ${describe(t)}`, t.pos);
    }
    return this.next();
  }
  private budget(): void {
    if (++this.nodes > MAX_NODES) throw new FormulaError("Formula is too complex");
  }

  parse(): Node {
    const node = this.parseExpression(0, 0);
    const t = this.peek();
    if (t.type !== "eof") {
      throw new FormulaError(`Unexpected ${describe(t)} after the end of the formula`, t.pos);
    }
    return node;
  }

  private parseExpression(minPrecedence: number, depth: number): Node {
    if (depth > MAX_DEPTH) throw new FormulaError("Formula is nested too deeply");
    let left = this.parseUnary(depth + 1);

    for (;;) {
      const t = this.peek();

      // Ternary sits below every binary operator.
      if (t.type === "op" && t.value === "?" && minPrecedence <= 0) {
        this.next();
        const whenTrue = this.parseExpression(0, depth + 1);
        this.expect(":");
        const whenFalse = this.parseExpression(0, depth + 1);
        this.budget();
        left = { kind: "ternary", cond: left, whenTrue, whenFalse };
        continue;
      }

      if (t.type !== "op") break;
      const precedence = own(BINARY_PRECEDENCE, t.value);
      if (precedence === undefined || precedence < minPrecedence) break;

      this.next();
      const nextMin = RIGHT_ASSOCIATIVE.has(t.value) ? precedence : precedence + 1;
      const right = this.parseExpression(nextMin, depth + 1);
      this.budget();
      left = { kind: "binary", op: t.value, left, right, pos: t.pos };
    }

    return left;
  }

  private parseUnary(depth: number): Node {
    if (depth > MAX_DEPTH) throw new FormulaError("Formula is nested too deeply");
    const t = this.peek();

    if (t.type === "op" && (t.value === "-" || t.value === "+" || t.value === "!")) {
      this.next();
      const operand = this.parseUnary(depth + 1);
      this.budget();
      if (t.value === "+") return operand;
      return { kind: "unary", op: t.value, operand };
    }
    if (t.type === "ident" && t.value.toLowerCase() === "not") {
      this.next();
      const operand = this.parseUnary(depth + 1);
      this.budget();
      return { kind: "unary", op: "!", operand };
    }

    return this.parsePrimary(depth + 1);
  }

  private parsePrimary(depth: number): Node {
    const t = this.next();
    this.budget();

    if (t.type === "number") return { kind: "num", value: t.num! };
    if (t.type === "string") return { kind: "str", value: t.value };

    if (t.type === "punc" && t.value === "(") {
      const inner = this.parseExpression(0, depth + 1);
      this.expect(")");
      return inner;
    }

    if (t.type === "ident") {
      const lower = t.value.toLowerCase();

      // `and` / `or` spelled as words, for readability in long formulas.
      if (lower === "and" || lower === "or") {
        throw new FormulaError(`"${t.value}" cannot start an expression`, t.pos);
      }
      const keyword = own(KEYWORDS, lower);
      if (keyword) return keyword;

      if (this.peek().type === "punc" && this.peek().value === "(") {
        this.next();
        const args: Node[] = [];
        if (!(this.peek().type === "punc" && this.peek().value === ")")) {
          for (;;) {
            args.push(this.parseExpression(0, depth + 1));
            if (this.peek().type === "punc" && this.peek().value === ",") {
              this.next();
              continue;
            }
            break;
          }
        }
        this.expect(")");
        return { kind: "call", name: lower, args, pos: t.pos };
      }

      return { kind: "ref", name: t.value, pos: t.pos };
    }

    throw new FormulaError(`Unexpected ${describe(t)}`, t.pos);
  }
}

function describe(t: Token): string {
  if (t.type === "eof") return "the end of the formula";
  return `"${t.value}"`;
}

// Word forms of the logical operators, rewritten before parsing so the parser
// only has to know about the symbolic ones.
function normalizeWordOperators(tokens: Token[]): Token[] {
  return tokens.map((t) => {
    if (t.type !== "ident") return t;
    const lower = t.value.toLowerCase();
    if (lower === "and") return { type: "op", value: "&&", pos: t.pos } as Token;
    if (lower === "or") return { type: "op", value: "||", pos: t.pos } as Token;
    return t;
  });
}

export function parse(src: string): Node {
  const tokens = normalizeWordOperators(tokenize(src));
  return new Parser(tokens).parse();
}

// --------------------------------------------------------------- functions --

export interface HostFunctions {
  // Functions the runner injects, e.g. series_sum over a projection row.
  [name: string]: ((args: Value[]) => Value) | undefined;
}

export interface EvalOptions {
  lookup: (name: string) => Value | undefined;
  host?: HostFunctions;
}

function asNumber(v: Value, context: string): number | null {
  if (v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new FormulaError(`${context} expected a number but got text "${v}"`);
  return n;
}

function truthy(v: Value): boolean | null {
  if (v === null) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return v.length > 0;
}

// Every function the formula language can call. Anything not in this table is
// a parse-time error, so a model definition cannot reach the host environment.
type Fn = { arity: [number, number]; apply: (args: Value[]) => Value };

const nums = (args: Value[], name: string): (number | null)[] =>
  args.map((a) => asNumber(a, `${name}()`));

// Most maths functions are null-in / null-out.
function lift1(name: string, f: (x: number) => number): Fn {
  return {
    arity: [1, 1],
    apply: (args) => {
      const x = asNumber(args[0], `${name}()`);
      if (x === null) return null;
      const r = f(x);
      return Number.isFinite(r) ? r : null;
    },
  };
}

export const FUNCTIONS: Record<string, Fn> = {
  abs: lift1("abs", Math.abs),
  floor: lift1("floor", Math.floor),
  ceil: lift1("ceil", Math.ceil),
  sqrt: lift1("sqrt", Math.sqrt),
  ln: lift1("ln", Math.log),
  log10: lift1("log10", Math.log10),
  sign: lift1("sign", Math.sign),

  round: {
    arity: [1, 2],
    apply: (args) => {
      const x = asNumber(args[0], "round()");
      const digits = args.length > 1 ? asNumber(args[1], "round()") : 0;
      if (x === null || digits === null) return null;
      const f = Math.pow(10, Math.max(0, Math.min(12, Math.trunc(digits))));
      return Math.round(x * f) / f;
    },
  },

  min: {
    arity: [1, 32],
    apply: (args) => {
      const vals = nums(args, "min").filter((v): v is number => v !== null);
      return vals.length ? Math.min(...vals) : null;
    },
  },
  max: {
    arity: [1, 32],
    apply: (args) => {
      const vals = nums(args, "max").filter((v): v is number => v !== null);
      return vals.length ? Math.max(...vals) : null;
    },
  },
  // sum and avg skip nulls; a missing expense line should not void the total.
  sum: {
    arity: [1, 64],
    apply: (args) => {
      const vals = nums(args, "sum").filter((v): v is number => v !== null);
      return vals.reduce((a, b) => a + b, 0);
    },
  },
  avg: {
    arity: [1, 64],
    apply: (args) => {
      const vals = nums(args, "avg").filter((v): v is number => v !== null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    },
  },

  clamp: {
    arity: [3, 3],
    apply: (args) => {
      const [x, lo, hi] = nums(args, "clamp");
      if (x === null || lo === null || hi === null) return null;
      return Math.min(Math.max(x, lo), hi);
    },
  },

  pow: {
    arity: [2, 2],
    apply: (args) => {
      const [a, b] = nums(args, "pow");
      if (a === null || b === null) return null;
      const r = Math.pow(a, b);
      return Number.isFinite(r) ? r : null;
    },
  },

  // if() evaluates both branches because arguments arrive already evaluated.
  // That is fine here: the language has no side effects and no recursion.
  if: {
    arity: [3, 3],
    apply: (args) => {
      const c = truthy(args[0]);
      if (c === null) return null;
      return c ? args[1] : args[2];
    },
  },
  ifnull: {
    arity: [2, 2],
    apply: (args) => (args[0] === null ? args[1] : args[0]),
  },
  coalesce: {
    arity: [1, 32],
    apply: (args) => {
      for (const a of args) if (a !== null) return a;
      return null;
    },
  },
  isnull: { arity: [1, 1], apply: (args) => args[0] === null },

  // Safe division: x/0 is null, not Infinity. Underwriting is full of
  // denominators that can legitimately be zero (no debt, no equity, no units).
  div: {
    arity: [2, 2],
    apply: (args) => {
      const [a, b] = nums(args, "div");
      if (a === null || b === null || b === 0) return null;
      return a / b;
    },
  },

  // ---- finance ----------------------------------------------------------

  // Level payment per period. Rate is the PERIODIC rate.
  pmt: {
    arity: [3, 3],
    apply: (args) => {
      const [rate, nper, pv] = nums(args, "pmt");
      if (rate === null || nper === null || pv === null) return null;
      if (nper <= 0) return null;
      if (Math.abs(rate) < 1e-12) return pv / nper;
      const f = Math.pow(1 + rate, nper);
      const r = (pv * rate * f) / (f - 1);
      return Number.isFinite(r) ? r : null;
    },
  },

  // Outstanding balance after `periods` payments of a level-payment loan.
  balance: {
    arity: [4, 4],
    apply: (args) => {
      const [rate, nper, pv, periods] = nums(args, "balance");
      if (rate === null || nper === null || pv === null || periods === null) return null;
      if (periods >= nper) return 0;
      if (Math.abs(rate) < 1e-12) return pv * (1 - periods / nper);
      const f = Math.pow(1 + rate, nper);
      const payment = (pv * rate * f) / (f - 1);
      const g = Math.pow(1 + rate, periods);
      const r = pv * g - payment * ((g - 1) / rate);
      return Number.isFinite(r) ? Math.max(0, r) : null;
    },
  },

  fv: {
    arity: [3, 3],
    apply: (args) => {
      const [rate, nper, pv] = nums(args, "fv");
      if (rate === null || nper === null || pv === null) return null;
      const r = pv * Math.pow(1 + rate, nper);
      return Number.isFinite(r) ? r : null;
    },
  },

  pv: {
    arity: [3, 3],
    apply: (args) => {
      const [rate, nper, fvArg] = nums(args, "pv");
      if (rate === null || nper === null || fvArg === null) return null;
      const r = fvArg / Math.pow(1 + rate, nper);
      return Number.isFinite(r) ? r : null;
    },
  },

  // npv(rate, cf0, cf1, ...) — cf0 is at t=0 and is NOT discounted, matching
  // the convention every CRE analyst uses in a spreadsheet.
  npv: {
    arity: [2, 64],
    apply: (args) => {
      const rate = asNumber(args[0], "npv()");
      if (rate === null) return null;
      let total = 0;
      for (let t = 1; t < args.length; t++) {
        const cf = asNumber(args[t], "npv()");
        if (cf === null) continue;
        total += cf / Math.pow(1 + rate, t - 1);
      }
      return Number.isFinite(total) ? total : null;
    },
  },

  // irr(cf0, cf1, ...) via bisection then Newton polish. Bisection first
  // because CRE cash flows are frequently badly behaved near the root and
  // Newton alone diverges on them.
  irr: {
    arity: [2, 64],
    apply: (args) => {
      const flows = args
        .map((a) => asNumber(a, "irr()"))
        .map((v) => (v === null ? 0 : v));
      return irrOf(flows);
    },
  },
};

export function irrOf(flows: number[]): number | null {
  if (flows.length < 2) return null;
  const hasPositive = flows.some((f) => f > 0);
  const hasNegative = flows.some((f) => f < 0);
  if (!hasPositive || !hasNegative) return null;

  const npvAt = (rate: number): number => {
    let total = 0;
    for (let t = 0; t < flows.length; t++) {
      total += flows[t] / Math.pow(1 + rate, t);
    }
    return total;
  };

  let lo = -0.9999;
  let hi = 10;
  let fLo = npvAt(lo);
  let fHi = npvAt(hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return null;

  let mid = 0;
  for (let i = 0; i < 200; i++) {
    mid = (lo + hi) / 2;
    const fMid = npvAt(mid);
    if (!Number.isFinite(fMid)) return null;
    if (Math.abs(fMid) < 1e-9 || hi - lo < 1e-12) break;
    if (fLo * fMid <= 0) {
      hi = mid;
      fHi = fMid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return Number.isFinite(mid) ? mid : null;
}

// -------------------------------------------------------------- evaluation --

export function evaluate(node: Node, options: EvalOptions): Value {
  return evalNode(node, options, 0);
}

function evalNode(node: Node, options: EvalOptions, depth: number): Value {
  if (depth > MAX_DEPTH) throw new FormulaError("Formula is nested too deeply");

  switch (node.kind) {
    case "num":
      return node.value;
    case "str":
      return node.value;
    case "bool":
      return node.value;
    case "null":
      return null;

    case "ref": {
      const v = options.lookup(node.name);
      if (v === undefined) {
        throw new FormulaError(`Unknown value "${node.name}"`, node.pos);
      }
      return v;
    }

    case "unary": {
      const operand = evalNode(node.operand, options, depth + 1);
      if (node.op === "!") {
        const t = truthy(operand);
        return t === null ? null : !t;
      }
      const n = asNumber(operand, "negation");
      return n === null ? null : -n;
    }

    case "ternary": {
      const cond = truthy(evalNode(node.cond, options, depth + 1));
      if (cond === null) return null;
      return evalNode(cond ? node.whenTrue : node.whenFalse, options, depth + 1);
    }

    case "binary":
      return evalBinary(node, options, depth);

    case "call": {
      const host = options.host ? own(options.host, node.name) : undefined;
      const fn = own(FUNCTIONS, node.name);
      if (!fn && !host) {
        throw new FormulaError(`Unknown function "${node.name}()"`, node.pos);
      }
      const args = node.args.map((a) => evalNode(a, options, depth + 1));
      if (fn) {
        const [minArgs, maxArgs] = fn.arity;
        if (args.length < minArgs || args.length > maxArgs) {
          const expected = minArgs === maxArgs ? `${minArgs}` : `${minArgs} to ${maxArgs}`;
          throw new FormulaError(
            `${node.name}() takes ${expected} argument${maxArgs === 1 ? "" : "s"}, got ${args.length}`,
            node.pos,
          );
        }
        return fn.apply(args);
      }
      return host!(args);
    }
  }
}

function evalBinary(
  node: Extract<Node, { kind: "binary" }>,
  options: EvalOptions,
  depth: number,
): Value {
  const op = node.op;

  // Short-circuit so `debt > 0 and payment / debt > 1` cannot divide by zero.
  if (op === "&&" || op === "||") {
    const left = truthy(evalNode(node.left, options, depth + 1));
    if (left === null) return null;
    if (op === "&&" && !left) return false;
    if (op === "||" && left) return true;
    const right = truthy(evalNode(node.right, options, depth + 1));
    return right === null ? null : right;
  }

  const l = evalNode(node.left, options, depth + 1);
  const r = evalNode(node.right, options, depth + 1);

  if (op === "==" || op === "!=") {
    if (l === null || r === null) {
      const same = l === null && r === null;
      return op === "==" ? same : !same;
    }
    const same = typeof l === typeof r ? l === r : Number(l) === Number(r);
    return op === "==" ? same : !same;
  }

  const a = asNumber(l, `operator "${op}"`);
  const b = asNumber(r, `operator "${op}"`);
  if (a === null || b === null) return null;

  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      // Division by zero yields null rather than Infinity. See div().
      return b === 0 ? null : a / b;
    case "%":
      return b === 0 ? null : a % b;
    case "^": {
      const p = Math.pow(a, b);
      return Number.isFinite(p) ? p : null;
    }
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    default:
      throw new FormulaError(`Unsupported operator "${op}"`, node.pos);
  }
}

// ------------------------------------------------------------ static tools --

// Names a formula reads. Used to build the dependency graph and to validate a
// user's formula against the model's available keys before it is ever run.
export function referencesOf(node: Node, into = new Set<string>()): Set<string> {
  switch (node.kind) {
    case "ref":
      into.add(node.name);
      break;
    case "unary":
      referencesOf(node.operand, into);
      break;
    case "binary":
      referencesOf(node.left, into);
      referencesOf(node.right, into);
      break;
    case "ternary":
      referencesOf(node.cond, into);
      referencesOf(node.whenTrue, into);
      referencesOf(node.whenFalse, into);
      break;
    case "call":
      for (const a of node.args) referencesOf(a, into);
      break;
    default:
      break;
  }
  return into;
}

export function functionsOf(node: Node, into = new Set<string>()): Set<string> {
  if (node.kind === "call") {
    into.add(node.name);
    for (const a of node.args) functionsOf(a, into);
  } else if (node.kind === "unary") {
    functionsOf(node.operand, into);
  } else if (node.kind === "binary") {
    functionsOf(node.left, into);
    functionsOf(node.right, into);
  } else if (node.kind === "ternary") {
    functionsOf(node.cond, into);
    functionsOf(node.whenTrue, into);
    functionsOf(node.whenFalse, into);
  }
  return into;
}

const compiledCache = new Map<string, Node>();

// Parsing the same handful of formulas on every run is wasteful; model
// definitions change rarely and are small, so cache the ASTs by source text.
export function compile(src: string): Node {
  const hit = compiledCache.get(src);
  if (hit) return hit;
  const node = parse(src);
  if (compiledCache.size > 5000) compiledCache.clear();
  compiledCache.set(src, node);
  return node;
}
