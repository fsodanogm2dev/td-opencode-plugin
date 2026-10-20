// OpenCode loads a local plugin directory through `<dir>/index.*` or `<dir>/server.*` and ignores package.json
// `exports`. This file makes the repository root loadable as a local plugin directory.
export { default } from "./src/index.ts"
