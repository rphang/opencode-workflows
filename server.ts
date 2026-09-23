// Directory-install entry point. opencode resolves a plugin *directory* target
// (`"plugins": ["file:///path/to/opencode-workflows"]`) to `<dir>/server` then `<dir>/index`,
// ignoring package.json `main`/`exports`, so this file makes the repo loadable as a directory.
export { default } from "./src/index.ts"
