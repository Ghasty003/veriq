# Contributing and local development

## Development setup

Use Node.js 22.18 or newer:

```sh
npm ci
npm link
```

Edit `src/`, not generated `dist/` files. `npm run dev -- run <url>` runs source
directly. `npm run build` updates the linked executable.

Standard tests and fixtures live in this repository and need no companion
workspace. Keep the optional local `../veriq-testcase` applications outside the
repository; they are not required for contributors. See [testing](docs/testing.md)
for the standard checks and optional experiments.

## Before committing

```sh
npm run check
```

Update documentation with each behavior change. Explain the purpose of each
command or component, configuration, setup, exact test commands, expected
results and relevant limitations. Documentation should not include quizzes or
review questions.

Commit source, tests, documentation, configuration examples and
`package-lock.json`. Dependencies and build output are ignored. Keep actual
credentials and environment files out of commits.

## First GitHub push

For a project directory that is not yet initialized as a Git repository,
create an empty GitHub repository, then run these commands from `veriq`:

```sh
git init -b main
git add .gitignore README.md CONTRIBUTING.md PLAN.md docs examples src test package.json package-lock.json tsconfig.json tsconfig.test.json
git diff --cached --stat
git diff --cached
git commit -m "Add Veriq HTTP experiments and documentation"
```

Inspect the staged changes before committing. Replace `YOUR_USERNAME` in the
URL below with the actual repository owner, and use the actual repository name
if it differs from `veriq`:

```sh
git remote add origin https://github.com/YOUR_USERNAME/veriq.git
git push -u origin main
```

These instructions assume an empty remote repository and working GitHub Git
authentication. If the directory is already initialized, inspect `git status`
and `git remote -v` instead of adding another remote. No force push is needed
for the empty-remote setup described here.

Contributors can run the full standard test suite with only this repository.
The optional companion application experiments are outside the GitHub project.
