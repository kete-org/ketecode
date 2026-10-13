// `/commit` and `/pr`: built-in prompt commands for the git work people do at the end of a change
// (docs/parity-plan.md A3), registered like upstream's `/init` and `/review` (plugin/command.ts). They are
// plain prompts: the agent does the work with its own tools, so every `git add`, `git commit`, `git push`
// and `gh pr create` goes through the permission system and the OS sandbox like any other command
// (`git push` asks by default). No template runs shell itself. A `commit` or `pr` command in the person's or the
// project's config replaces these (config commands load later, plugin/internal.ts `post`).

export * as KeteGitCommands from "./git-commands.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { Location } from "../location.js"

export const COMMIT = `Create a git commit for the current changes in \${path}.

Notes from the person (optional): $ARGUMENTS

1. Check the state first with \`git status --short --branch\` and \`git diff --stat\` (and \`git diff --cached --stat\`). Stop and say why if:
   - this isn't a git repository, or there is nothing to commit;
   - a merge, rebase, cherry-pick, revert or bisect is in progress (\`.git/MERGE_HEAD\`, \`.git/rebase-merge\`, \`.git/rebase-apply\`, \`.git/CHERRY_PICK_HEAD\`, \`.git/REVERT_HEAD\`, \`.git/BISECT_LOG\`), or any path is unmerged (\`UU\`, \`AA\`, \`DU\`… in the status);
   - HEAD is detached (\`git branch --show-current\` prints nothing).
2. Choose what goes in the commit:
   - If some changes are already staged, commit only those.
   - If nothing is staged, stage the files that belong to one change, naming each path (\`git add -- <path> …\`). Never use \`git add -A\`, \`git add .\` or \`git commit -a\`.
   - If the changes are unrelated, say so and suggest separate commits; commit them together only if the person asked for that.
3. Secrets and local state: never stage \`.env\` files, keys and certificates (\`*.pem\`, \`*.key\`, \`id_rsa\`), credential files, large binaries or build output, and don't print or quote their contents. Read the diff (\`git diff -- <path>\`, \`git diff --cached -- <path>\`) only for the other files. Mention the skipped ones.
4. The default branch is the remote's (\`git symbolic-ref --short refs/remotes/origin/HEAD\`, or \`git remote show origin\`), otherwise \`main\` or \`master\`. If the current branch is the default branch or another protected branch, ask whether to commit there or on a new branch, and suggest a name such as \`feature/<topic>\` or \`fix/<topic>\`. If you can't ask, create the branch (\`git switch -c <name>\`) and commit there.
5. Read \`git log -n 10 --format=%s\` and follow its style (for example Conventional Commits, \`type(scope): summary\`). Write a subject of at most 72 characters in the imperative mood that says what changed and why. Add a body when the reason isn't obvious from the subject. Use the person's notes for intent. Don't invent changes the diff doesn't show.
6. Pass the message without letting the shell interpret it: write it to a file in the system temp directory (outside the repository) and run \`git commit -F <file>\`, then delete the file. Never put the message in \`-m "…"\`, where quotes, backticks or \`$(…)\` would break it or run something. Don't use \`--no-verify\` or \`--amend\`, and don't change git config, unless the person asked. If a hook fails, show its output, fix the cause if it is small and part of this change, stage the fix and commit again (a new commit, not an amend).
7. Don't push.

Finish with the commit's short hash and subject, and list anything left uncommitted.`

export const PR = `Open a pull request (a merge request on GitLab) for the current branch in \${path}.

What the person wrote (optional): $ARGUMENTS
Read it this way: if its first word names a branch that exists on the remote, that is the base; the word "draft" anywhere makes it a draft; everything else is notes for the description. If it's unclear, ask.

1. Check the state with \`git status --short --branch\`. Stop and say why if a merge, rebase, cherry-pick or revert is in progress, any path is unmerged, or HEAD is detached. If there are uncommitted changes, ask whether to commit them first (the way /commit does) or leave them out.
2. Find the current branch (\`git branch --show-current\`), the remote (\`origin\`, unless the branch tracks another; if you work from a fork, the pull request goes to the upstream repository) and the base: the branch the person named, otherwise the remote's default (\`git symbolic-ref --short refs/remotes/origin/HEAD\`, \`git remote show origin\`, or \`gh repo view --json defaultBranchRef\`; ask if none works). If the current branch is the base, stop and suggest creating a branch.
3. Run \`git fetch <remote> <base>\`, then compare with the remote's base, not a possibly stale local one: \`git log --oneline <remote>/<base>..HEAD\` and \`git diff --stat <remote>/<base>...HEAD\`. Read the diff where you need to, but don't print or quote the contents of secret files (\`.env\`, keys, credentials); if a commit adds one, stop and say so before pushing.
4. If a pull request for this branch already exists (\`gh pr view --json url\`, \`glab mr view\`), don't create another: push any new commits and report its URL.
5. If the branch has no upstream or has commits the remote doesn't, push it with \`git push -u <remote> <branch>\`. Never force-push. If the push is rejected, explain why and stop.
6. Write a title of at most 72 characters in the style of the repository's commits, and a description: what changed and why, how it was tested, and anything a reviewer should know. If the repository has a pull request template (\`.github/pull_request_template.md\`, \`.gitlab/merge_request_templates/\`), follow it. Don't claim tests or checks you didn't see pass. Write the description to a file in the system temp directory (outside the repository, deleted afterwards), never into the working tree, and never pass it in a quoted shell argument.
7. Create it:
   - GitHub: \`gh pr create --base <base> --title "<title>" --body-file <temp file>\` (\`--draft\` if asked). Keep quotes, backticks and \`$\` out of the title, or escape them.
   - GitLab: \`glab mr create --target-branch <base> --title "<title>" --description "$(cat <temp file>)"\` (\`--draft\` if asked). The text read from the file isn't run by the shell. In PowerShell use \`--description (Get-Content -Raw <temp file>)\`.
   - Other hosts (Bitbucket, Azure DevOps, Gitea…), or the CLI isn't installed or signed in: don't install anything. Print the title, the description and the URL to open the pull request in the browser, and say how to set up the CLI if there is one.
   Don't merge, approve, or request reviewers unless the person asked.

Finish with the pull request's URL.`

function prompt(template: string, path: string, input: string) {
  // One pass with a function replacer: `$&` or `$1` in the path or the person's text is kept as written,
  // and a path containing "$ARGUMENTS" isn't filled in again.
  const notes = input.trim() || "(none)"
  return template.replace(/\$\{path\}|\$ARGUMENTS/g, (match) => (match === "${path}" ? path : notes))
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
