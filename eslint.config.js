/**
 * The cheap guard against the one bug class this project cannot see.
 *
 * Not a style config. Every rule below is here because it catches something
 * that passes `node --check`, passes review, and then fails in a way that does
 * not announce itself:
 *
 *   - a function declared twice at the top level, whose hoisted second
 *     definition wins at a call site where its own `const` is still in the
 *     temporal dead zone. The page loads, the socket streams, and every line of
 *     script after that point never runs — so a control simply does nothing.
 *     Syntactically valid; `no-redeclare` and `no-use-before-define` see it.
 *   - a typo in an identifier inside a branch that only runs on a venue having
 *     a bad night. `no-undef` sees it; nothing else here does.
 *   - a value read from an object that was mutated by an await in between.
 *     `require-atomic-updates` sees it.
 *
 * Anything that is a matter of taste is off. A linter that argues about commas
 * gets turned off, and takes the three rules above with it.
 */
export default [
  {
    files: ['**/*.js', '**/*.mjs'],
    ignores: ['node_modules/**', 'data/**', 'logs/**'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        // Node and the browser both, because shared/metrics.js is loaded by
        // each of them and is the one file that must run in both.
        console: 'readonly', process: 'readonly', Buffer: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        setImmediate: 'readonly', queueMicrotask: 'readonly',
        fetch: 'readonly', URL: 'readonly', AbortController: 'readonly',
        globalThis: 'readonly', structuredClone: 'readonly',
        TextDecoder: 'readonly', TextEncoder: 'readonly',
        window: 'readonly', document: 'readonly', location: 'readonly',
        innerWidth: 'readonly', innerHeight: 'readonly',
        localStorage: 'readonly', navigator: 'readonly',
        WebSocket: 'readonly', requestAnimationFrame: 'readonly',
        PointerEvent: 'readonly',   // page.evaluate bodies run in the browser
        devicePixelRatio: 'readonly', getComputedStyle: 'readonly',
      },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      // The three that would have caught real incidents.
      'no-redeclare': 'error',
      'no-use-before-define': ['error', { functions: false, classes: true, variables: true }],
      'no-undef': 'error',
      'require-atomic-updates': 'error',

      // Silent wrongness, all of it invisible at review.
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-fallthrough': 'error',
      'no-self-compare': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-negation': 'error',
      'no-unreachable': 'error',
      'no-sparse-arrays': 'error',
      'no-cond-assign': ['error', 'always'],
      'no-constant-binary-expression': 'error',
      'no-async-promise-executor': 'error',
      'no-control-regex': 'error',
      // Two rules deliberately OFF, because on this codebase they are noise and
      // a linter that cries wolf gets switched off entirely:
      //
      //   no-promise-executor-return  flags `new Promise(r => setTimeout(r, ms))`
      //     — twenty times here — for returning a timer handle nobody reads. The
      //     trap it exists for is `new Promise(r => fetch().then(r))`, which this
      //     repo does not contain.
      //   no-unmodified-loop-condition  cannot see through a closure, so it
      //     flags every drain loop whose condition a callback advances.
      'no-promise-executor-return': 'off',
      'no-unmodified-loop-condition': 'off',
      'valid-typeof': 'error',
      'use-isnan': 'error',
      // `== null` is deliberate throughout: null and undefined are the same
      // answer here, and every other comparison is meant to be strict.
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      // Dead code is a claim about intent that stopped being true.
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' }],

      // Left in by accident, and both of them ship.
      'no-debugger': 'error',
      'no-console': 'off',   // the tools ARE console output
    },
  },
];
