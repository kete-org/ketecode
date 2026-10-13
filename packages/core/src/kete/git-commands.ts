// `/commit` and `/pr`: built-in prompt commands for the git work people do at the end of a change
// (docs/parity-plan.md A3), registered like upstream's `/init` and `/review` (plugin/command.ts). They are
// plain prompts: the agent does the work with its own tools, so every `git add`, `git commit`, `git push`
// and `gh pr create` goes through the permission system and the OS sandbox like any other command
// (`git push` always asks). No template runs shell itself. A `commit` or `pr` command in the person's or the
// project's config replaces these (config commands load later, plugin/internal.ts `post`).

export * as KeteGitCommands from "./git-commands.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { Location } from "../location.js"

export const COMMIT = `Create a git commit for the current changes in \${path}.

Notes from the person (optional): $ARGUMENTS

1. Run \`git status --short\`, \`git diff --cached\` and \`git diff\` to see what changed. If this isn't a git repository, or there is nothing to commit, say so and stop.
2. Choose what goes in the commit:
   - If some changes are already staged, commit only those.
   - If nothing is staged, stage the files that belong to one change, naming each path (\`git add <path> …\`). Never use \`git add -A\`, \`git add .\` or \`git commit -a\`.
   - If the changes are unrelated, say so and suggest separate commits; commit them together only if the person asked for that.
3. Never stage files that look like secrets or local state: \`.env\` files, keys and certificates (\`*.pem\`, \`*.key\`, \`id_rsa\`), credential files, large binaries, build output. Mention them instead.
4. If the current branch is the repository's default branch (\`main\`, \`master\`) or another protected branch, ask whether to commit there or create a branch first, and suggest a name such as \`feature/<topic>\` or \`fix/<topic>\`.
5. Read \`git log -n 10 --format=%s\` and follow its style (for example Conventional Commits, \`type(scope): summary\`). Write a subject of at most 72 characters in the imperative mood that says what changed and why. Add a body when the reason isn't obvious from the subject. Use the person's notes for intent. Don't invent changes the diff doesn't show.
6. Commit with \`git commit -m "<subject>" -m "<body>"\`. Don't use \`--no-verify\` or \`--amend\`, and don't change git config, unless the person asked. If a hook fails, show its output, fix the cause if it is small and part of this change, stage the fix and commit again (a new commit, not an amend).
7. Don't push.

Finish with the commit's short hash and subject, and list anything left uncommitted.`

export const PR = `Open a pull request (a merge request on GitLab) for the current branch in \${path}.

Base branch and notes from the person (optional; "draft" makes it a draft): $ARGUMENTS

1. Run \`git status --short\`. If there are uncommitted changes, ask whether to commit them first (the way /commit does) or leave them out.
2. Find the current branch (\`git branch --show-current\`) and the base: the branch the person named, otherwise the remote's default branch (\`git symbolic-ref --short refs/remotes/origin/HEAD\`, or \`gh repo view --json defaultBranchRef\`). If HEAD is detached, or the current branch is the base, stop and suggest creating a branch.
3. Look at everything the pull request will contain, not only the last commit: \`git log --oneline <base>..HEAD\` and \`git diff <base>...HEAD --stat\`, and read the diff where you need to.
4. If the branch has no upstream or has commits the remote doesn't, push it with \`git push -u origin <branch>\`. Never force-push. If the push is rejected, explain why and stop.
5. Write a title of at most 72 characters in the style of the repository's commits, and a description: what changed and why, how it was tested, and anything a reviewer should know. If the repository has a pull request template (\`.github/pull_request_template.md\`, \`.gitlab/merge_request_templates/\`), follow it. Don't claim tests or checks you didn't see pass.
6. Create it:
   - GitHub: \`gh pr create --base <base> --title "<title>" --body-file <file>\` (\`--draft\` if asked).
   - GitLab: \`glab mr create --target-branch <base> --title "<title>" --description "<description>"\` (\`--draft\` if asked).
   - If the right CLI isn't installed or signed in, don't install it: print the title, the description and the URL to open the pull request in the browser, and say how to set the CLI up.
   Don't merge, approve, or request reviewers unless the person asked.

Finish with the pull request's URL.`

function prompt(template: string, path: string, input: string) {
  // Function replacers, so `$&` or `$1` in a path or the person's text is kept as written.
  const notes = input.trim() || "(none)"
  return template.replaceAll("${path}", () => path).replaceAll("$ARGUMENTS", () => notes)
}

export const Plugin = define({
  id: "kete.git-commands",
  effect: Effect.fn(function* (ctx) {
    const location = yield* Location.Service
    yield* ctx.command.transform((editor) => {
      for (const [name, description, template] of [
        ["commit", "commit the current changes with a message in the repository's style", COMMIT],
        ["pr", "push the branch and open a pull request [base branch] [draft]", PR],
      ] as const)
        editor.add({
          name,
          description,
          execute: (input) =>
            ctx.session
              .prompt({
                ...input.prompt,
                sessionID: input.sessionID,
                text: prompt(template, location.project.directory, input.prompt.text),
                delivery: input.delivery,
              })
              .pipe(Effect.asVoid),
        })
    })
  }),
})

export { prompt as render }
