// Every command and path from the PR #20 re-review repro scripts (t2.ts, t3.ts), with the reviewed
// classification: risk, whether the whole-line `cd` check flags it, and whether "Always allow" may
// be saved for it. Entry points and protected paths from the same scripts are below.
import { describe, expect, test } from "bun:test"
import { KeteShellRisk } from "@opencode/core/kete/shell-risk"

type Row = readonly [command: string, risk: KeteShellRisk.Risk, lineHigh: boolean, saveable: boolean]

const rows: ReadonlyArray<Row> = [
  [
   "cp payload .gi?/config",
   "high",
   false,
   false
  ],
  [
   "cp payload .gi[t]/config",
   "high",
   false,
   false
  ],
  [
   "echo x > .gi?/config",
   "high",
   false,
   false
  ],
  [
   "tee .ke?e/kete.jsonc",
   "high",
   false,
   false
  ],
  [
   "ln -s .ke?e k",
   "high",
   false,
   false
  ],
  [
   "ln -s .git g",
   "high",
   false,
   false
  ],
  [
   "mv x .git/hooks/pre-commit",
   "high",
   false,
   false
  ],
  [
   "install -m755 x .git/hooks/pre-commit",
   "high",
   false,
   false
  ],
  [
   "cat payload > .GIT/config",
   "high",
   false,
   false
  ],
  [
   "rsync x .git/config",
   "high",
   false,
   false
  ],
  [
   "dd of=.git/config",
   "high",
   false,
   false
  ],
  [
   "printf x | tee -a .Kete/agent/x.md",
   "high",
   false,
   false
  ],
  [
   "cp -r agentdir .kete",
   "high",
   false,
   false
  ],
  [
   "sed 's/a/b/w .git/config' f",
   "high",
   false,
   false
  ],
  [
   "git config core.fsmonitor x",
   "high",
   false,
   false
  ],
  [
   "git --git-dir=.git config --list",
   "high",
   false,
   false
  ],
  [
   "touch .git/hooks/x",
   "high",
   false,
   false
  ],
  [
   "chmod +x .git/hooks/pre-commit",
   "high",
   false,
   false
  ],
  [
   "unzip x.zip -d .kete",
   "high",
   false,
   false
  ],
  [
   "tar xf x.tar",
   "other",
   false,
   false
  ],
  [
   "git apply evil.patch",
   "other",
   false,
   false
  ],
  [
   "git checkout evil-branch -- .kete",
   "high",
   false,
   false
  ],
  [
   "git am x.patch",
   "other",
   false,
   false
  ],
  [
   "patch -p1 < x.diff",
   "other",
   false,
   false
  ],
  [
   "git stash pop",
   "other",
   false,
   true
  ],
  [
   "git merge evil",
   "other",
   false,
   true
  ],
  [
   "git pull",
   "other",
   false,
   true
  ],
  [
   "git submodule update --init",
   "other",
   false,
   false
  ],
  [
   "npm pkg set scripts.test='id'",
   "high",
   false,
   false
  ],
  [
   "npm set-script test id",
   "high",
   false,
   false
  ],
  [
   "npm config set script-shell ./x",
   "high",
   false,
   false
  ],
  [
   "pnpm pkg set scripts.test=id",
   "high",
   false,
   false
  ],
  [
   "yarn config set x y",
   "high",
   false,
   false
  ],
  [
   "git update-index --assume-unchanged x",
   "other",
   false,
   true
  ],
  [
   "find . -name x -exec cp payload .git/config ';'",
   "high",
   false,
   false
  ],
  [
   "rg --pre=sh x",
   "high",
   false,
   false
  ],
  [
   "rg -z x",
   "read",
   false,
   true
  ],
  [
   "rg --search-zip x",
   "read",
   false,
   true
  ],
  [
   "jq -n '$__prog_args'",
   "read",
   false,
   true
  ],
  [
   "jq -n 'env.HOME'",
   "high",
   false,
   false
  ],
  [
   "jq -n '$ENV.AWS'",
   "high",
   false,
   false
  ],
  [
   "jq -n 'getpath([\"a\"])'",
   "read",
   false,
   true
  ],
  [
   "jq -rn '[env[]]'",
   "high",
   false,
   false
  ],
  [
   "jq --arg x y -n 'input_filename'",
   "read",
   false,
   true
  ],
  [
   "yq -n 'env(HOME)'",
   "high",
   false,
   false
  ],
  [
   "yq -n 'strenv(AWS_SECRET)'",
   "high",
   false,
   false
  ],
  [
   "yq e '.a' f",
   "read",
   false,
   true
  ],
  [
   "awk 'BEGIN{print ENVIRON[\"X\"]}'",
   "high",
   false,
   false
  ],
  [
   "sed -n 's/a/b/w x' f",
   "other",
   false,
   false
  ],
  [
   "sed s/a/b/e f",
   "other",
   false,
   false
  ],
  [
   "sed 's/a/b/ge' f",
   "other",
   false,
   false
  ],
  [
   "sed '1!G' f",
   "other",
   false,
   false
  ],
  [
   "sed -n p f",
   "read",
   false,
   false
  ],
  [
   "sed --sandbox s/a/b/ f",
   "read",
   false,
   false
  ],
  [
   "sed 's/a/b/' -i f",
   "other",
   false,
   false
  ],
  [
   "sed y/abc/xyz/ f",
   "other",
   false,
   false
  ],
  [
   "sed -E 's/a/b/' f",
   "read",
   false,
   false
  ],
  [
   "bat --pager=less f",
   "high",
   false,
   false
  ],
  [
   "bat -p f",
   "read",
   false,
   true
  ],
  [
   "less f",
   "other",
   false,
   false
  ],
  [
   "git grep -O foo",
   "high",
   false,
   false
  ],
  [
   "git grep --open-files-in-pager foo",
   "high",
   false,
   false
  ],
  [
   "git -c core.pager=x log",
   "high",
   false,
   false
  ],
  [
   "git -ccore.pager=x log",
   "high",
   false,
   false
  ],
  [
   "git --no-pager -c x=y log",
   "high",
   false,
   false
  ],
  [
   "GIT_DIR=x git status",
   "other",
   false,
   true
  ],
  [
   "git status --porcelain",
   "read",
   false,
   true
  ],
  [
   "git diff --ext-diff",
   "other",
   false,
   true
  ],
  [
   "git diff --textconv",
   "other",
   false,
   true
  ],
  [
   "git log -p --output=x",
   "other",
   false,
   true
  ],
  [
   "git difftool",
   "other",
   false,
   false
  ],
  [
   "git show --output x",
   "other",
   false,
   true
  ],
  [
   "git -C .. status",
   "other",
   false,
   true
  ],
  [
   "git -C ../other branch -D main",
   "high",
   false,
   false
  ],
  [
   "npm --prefix ../other test",
   "other",
   false,
   true
  ],
  [
   "npm --prefix=/tmp test",
   "other",
   false,
   true
  ],
  [
   "pnpm -C ../x test",
   "other",
   false,
   true
  ],
  [
   "bun --cwd ../x test",
   "other",
   false,
   false
  ],
  [
   "make -C ../x test",
   "other",
   false,
   true
  ],
  [
   "cargo test --manifest-path ../x/Cargo.toml",
   "other",
   false,
   true
  ],
  [
   "go test -C ../x ./...",
   "other",
   false,
   true
  ],
  [
   "pytest --rootdir ..",
   "other",
   false,
   true
  ],
  [
   "pytest ../other",
   "other",
   false,
   true
  ],
  [
   "tsc -p ../x",
   "other",
   false,
   true
  ],
  [
   "npm test --prefix ..",
   "other",
   false,
   true
  ],
  [
   "xxd -r p o",
   "other",
   false,
   true
  ],
  [
   "xxd -rp p o",
   "other",
   false,
   true
  ],
  [
   "xxd -p -r p o",
   "other",
   false,
   true
  ],
  [
   "xxd -R p o",
   "read",
   false,
   true
  ],
  [
   "tree -o x",
   "other",
   false,
   true
  ],
  [
   "tree -fo x",
   "other",
   false,
   true
  ],
  [
   "tree --output x",
   "read",
   false,
   true
  ],
  [
   "command time -f x -o y true",
   "other",
   false,
   false
  ],
  [
   "env time -o .git/config true",
   "high",
   false,
   false
  ],
  [
   "time --output=y ls",
   "other",
   false,
   false
  ],
  [
   "go test -exec=x ./...",
   "other",
   false,
   true
  ],
  [
   "go test -exec x ./...",
   "other",
   false,
   true
  ],
  [
   "go test -toolexec x",
   "other",
   false,
   true
  ],
  [
   "go test -ldflags=-X ./...",
   "build",
   false,
   true
  ],
  [
   "go test -vet=off -o .git/hooks/pre-commit ./x",
   "high",
   false,
   false
  ],
  [
   "go build -o .git/hooks/pre-commit ./cmd",
   "high",
   false,
   false
  ],
  [
   "cargo build --target-dir .git",
   "high",
   false,
   false
  ],
  [
   "tsc --outDir .kete",
   "high",
   false,
   false
  ],
  [
   "bun build x.ts --outfile .git/hooks/pre-commit",
   "high",
   false,
   false
  ],
  [
   "npm run build -- --out-dir .kete/plugin",
   "high",
   false,
   false
  ],
  [
   "cargo test --config=x",
   "other",
   false,
   true
  ],
  [
   "cargo -Zunstable test",
   "other",
   false,
   true
  ],
  [
   "cargo --config x test",
   "other",
   false,
   true
  ],
  [
   "make test --eval=x",
   "other",
   false,
   true
  ],
  [
   "make CC=x test",
   "other",
   false,
   true
  ],
  [
   "make -e test",
   "build",
   false,
   true
  ],
  [
   "make -f x test",
   "other",
   false,
   true
  ],
  [
   "make -j4 test",
   "build",
   false,
   true
  ],
  [
   "make test -- SHELL=x",
   "other",
   false,
   true
  ],
  [
   "mvn test -Dexec.x",
   "other",
   false,
   true
  ],
  [
   "gradle test --init-script x",
   "other",
   false,
   true
  ],
  [
   "./gradlew test -I x",
   "other",
   false,
   true
  ],
  [
   "./gradlew test -Dx=y",
   "other",
   false,
   true
  ],
  [
   "dotnet test -p:VSTestTestAdapterPath=x",
   "other",
   false,
   true
  ],
  [
   "dotnet build /p:PreBuildEvent=x",
   "other",
   false,
   true
  ],
  [
   "dotnet test --logger x",
   "build",
   false,
   true
  ],
  [
   "pytest -p evil",
   "other",
   false,
   true
  ],
  [
   "pytest -o addopts=x",
   "other",
   false,
   true
  ],
  [
   "python -m pytest -p x",
   "other",
   false,
   false
  ],
  [
   "tox -x testenv.commands=id",
   "other",
   false,
   true
  ],
  [
   "nox -s x",
   "build",
   false,
   true
  ],
  [
   "deno test npm:evil",
   "high",
   false,
   false
  ],
  [
   "deno test --import-map=https://x",
   "high",
   false,
   false
  ],
  [
   "deno test -A x.ts",
   "build",
   false,
   false
  ],
  [
   "deno run https://x",
   "high",
   false,
   false
  ],
  [
   "deno check jsr:@x/y",
   "high",
   false,
   false
  ],
  [
   "npm run release:notes",
   "high",
   false,
   false
  ],
  [
   "npm run test:deploy",
   "high",
   false,
   false
  ],
  [
   "npm run prepublishOnly",
   "high",
   false,
   false
  ],
  [
   "npm run postinstall",
   "high",
   false,
   false
  ],
  [
   "npm run preinstall",
   "high",
   false,
   false
  ],
  [
   "npm run predeploy",
   "high",
   false,
   false
  ],
  [
   "npm run start",
   "other",
   false,
   true
  ],
  [
   "yarn deploy",
   "high",
   false,
   false
  ],
  [
   "pnpm run nuke",
   "high",
   false,
   false
  ],
  [
   "npm restart",
   "other",
   false,
   true
  ],
  [
   "cd",
   "high",
   true,
   false
  ],
  [
   "cd -",
   "high",
   true,
   false
  ],
  [
   "cd ~",
   "high",
   true,
   false
  ],
  [
   "pushd",
   "high",
   true,
   false
  ],
  [
   "pushd ..",
   "high",
   true,
   false
  ],
  [
   "popd",
   "read",
   false,
   true
  ],
  [
   "cd ..",
   "high",
   true,
   false
  ],
  [
   "cd sub",
   "read",
   false,
   true
  ],
  [
   "cd /tmp",
   "high",
   true,
   false
  ],
  [
   "cd $HOME",
   "high",
   true,
   false
  ],
  [
   "cd ${HOME}",
   "high",
   true,
   false
  ],
  [
   "CDPATH=/ cd etc",
   "high",
   false,
   false
  ],
  [
   "cd ''",
   "read",
   false,
   true
  ],
  [
   "cd \"\"",
   "read",
   false,
   true
  ],
  [
   "builtin cd",
   "high",
   false,
   false
  ],
  [
   "command cd",
   "high",
   false,
   false
  ],
  [
   "cd -P",
   "high",
   true,
   false
  ],
  [
   "cd -- ..",
   "high",
   true,
   false
  ],
  [
   "cd -L",
   "high",
   true,
   false
  ],
  [
   "Set-Location ~",
   "high",
   true,
   false
  ],
  [
   "sl ..",
   "high",
   true,
   false
  ],
  [
   "chdir",
   "high",
   true,
   false
  ],
  [
   "x=1 cd",
   "high",
   true,
   false
  ],
  [
   "cd sub && cd ..",
   "high",
   true,
   false
  ],
  [
   "cd sub/../..",
   "high",
   true,
   false
  ],
  [
   "cd sub; cd ../..",
   "high",
   true,
   false
  ],
  [
   "cd ~/x",
   "high",
   true,
   false
  ],
  [
   "cd .",
   "read",
   false,
   true
  ],
  [
   "cd '..'",
   "high",
   true,
   false
  ],
  [
   "r\\m -rf ~",
   "high",
   false,
   false
  ],
  [
   "\\rm -rf ~",
   "high",
   false,
   false
  ],
  [
   "r\"\"m -rf ~",
   "high",
   false,
   false
  ],
  [
   "{rm,-rf,~}",
   "high",
   false,
   false
  ],
  [
   "\"r\"m -rf ~",
   "high",
   false,
   false
  ],
  [
   "xargs -i rm -rf ~",
   "high",
   false,
   false
  ],
  [
   "xargs -irm x",
   "other",
   false,
   false
  ],
  [
   "xargs -I {} rm {}",
   "high",
   false,
   false
  ],
  [
   "xargs -0 rm",
   "high",
   false,
   false
  ],
  [
   "xargs --replace rm x",
   "high",
   false,
   false
  ],
  [
   "timeout 5 rm x",
   "high",
   false,
   false
  ],
  [
   "nice rm x",
   "high",
   false,
   false
  ],
  [
   "nohup rm x",
   "high",
   false,
   false
  ],
  [
   "stdbuf -oL rm x",
   "high",
   false,
   false
  ],
  [
   "exec rm x",
   "high",
   false,
   false
  ],
  [
   "command -p rm x",
   "high",
   false,
   false
  ],
  [
   "alias",
   "read",
   false,
   true
  ],
  [
   "alias ls='x'",
   "high",
   false,
   false
  ],
  [
   "unalias ls",
   "high",
   false,
   false
  ],
  [
   "hash -p /tmp/x ls",
   "high",
   false,
   false
  ],
  [
   "enable -f x y",
   "high",
   false,
   false
  ],
  [
   "trap 'rm -rf ~' EXIT",
   "high",
   false,
   false
  ],
  [
   "shopt -s expand_aliases",
   "other",
   false,
   true
  ],
  [
   "set -o vi",
   "other",
   false,
   true
  ],
  [
   "export FOO=bar",
   "other",
   false,
   true
  ],
  [
   "declare -f",
   "high",
   false,
   false
  ],
  [
   "typeset -f",
   "high",
   false,
   false
  ],
  [
   "readonly x=1",
   "other",
   false,
   true
  ],
  [
   "local x=1",
   "other",
   false,
   true
  ],
  [
   "ulimit -n 1",
   "other",
   false,
   true
  ],
  [
   "eval ls",
   "other",
   false,
   false
  ],
  [
   "source x.sh",
   "other",
   false,
   false
  ],
  [
   ". x.sh",
   "other",
   false,
   false
  ],
  [
   "fc -s",
   "other",
   false,
   true
  ],
  [
   "history",
   "other",
   false,
   true
  ],
  [
   "watch ls",
   "other",
   false,
   false
  ],
  [
   "ps aux",
   "read",
   false,
   true
  ],
  [
   "ps -ef",
   "read",
   false,
   true
  ],
  [
   "ps e",
   "high",
   false,
   false
  ],
  [
   "ps -Eww",
   "high",
   false,
   false
  ],
  [
   "ps axe",
   "high",
   false,
   false
  ],
  [
   "ps -o command",
   "read",
   false,
   true
  ],
  [
   "ps aux -e",
   "read",
   false,
   true
  ],
  [
   "cat /proc/self/environ",
   "high",
   false,
   false
  ],
  [
   "cat /proc/1/environ",
   "high",
   false,
   false
  ],
  [
   "strings /proc/self/environ",
   "high",
   false,
   false
  ],
  [
   "tr '\\0' '\\n' < /proc/self/environ",
   "high",
   false,
   false
  ],
  [
   "gc env:X",
   "high",
   false,
   false
  ],
  [
   "Get-ChildItem Env:",
   "high",
   false,
   false
  ],
  [
   "dir env:",
   "high",
   false,
   false
  ],
  [
   "ls env:",
   "high",
   false,
   false
  ],
  [
   "echo $env:PATH",
   "high",
   false,
   false
  ],
  [
   "echo %PATH%",
   "high",
   false,
   false
  ],
  [
   "echo $PATH",
   "other",
   false,
   true
  ],
  [
   "echo ${PATH}",
   "other",
   false,
   true
  ],
  [
   "type .env",
   "high",
   false,
   false
  ],
  [
   "cat .ENV",
   "high",
   false,
   false
  ],
  [
   "cat .env.local",
   "high",
   false,
   false
  ],
  [
   "cat ./.env",
   "high",
   false,
   false
  ],
  [
   "cat sub/.env",
   "high",
   false,
   false
  ],
  [
   "cat .env.example",
   "read",
   false,
   true
  ],
  [
   "cat .env*",
   "high",
   false,
   false
  ],
  [
   "cat .*",
   "high",
   false,
   false
  ],
  [
   "cat *",
   "read",
   false,
   true
  ],
  [
   "grep -r KEY .",
   "read",
   false,
   true
  ],
  [
   "rg -uu KEY",
   "other",
   false,
   true
  ],
  [
   "rg --hidden KEY",
   "other",
   false,
   true
  ],
  [
   "cat .en[v]",
   "high",
   false,
   false
  ],
  [
   "cat .e?v",
   "high",
   false,
   false
  ],
  [
   "cat {.env,x}",
   "high",
   false,
   false
  ],
  [
   "cat .{env,x}",
   "high",
   false,
   false
  ],
  [
   "cat .e{n,}v",
   "high",
   false,
   false
  ],
  [
   "cat {~,}/.ssh/id_rsa",
   "high",
   false,
   false
  ],
  [
   "cat ~/.s{s,}h/x",
   "high",
   false,
   false
  ],
  [
   "cat {/etc,x}/passwd",
   "other",
   false,
   true
  ],
  [
   "cat x{,/../../etc/passwd}",
   "other",
   false,
   true
  ],
  [
   "find . -{delete,x}",
   "high",
   false,
   false
  ],
  [
   "find . -{exec,x} rm {} +",
   "high",
   false,
   false
  ],
  [
   "find . -fpr{int,x} y",
   "high",
   false,
   false
  ],
  [
   "find . -de{lete,}",
   "high",
   false,
   false
  ],
  [
   "fd -X rm",
   "high",
   false,
   false
  ],
  [
   "fd -Xrm",
   "high",
   false,
   false
  ],
  [
   "fd --exec-batch=rm x",
   "high",
   false,
   false
  ],
  [
   "fd -xrm",
   "high",
   false,
   false
  ],
  [
   "git log -{-output=x,}",
   "high",
   false,
   false
  ],
  [
   "git {push,x}",
   "high",
   false,
   false
  ],
  [
   "git p{ush,}",
   "high",
   false,
   false
  ],
  [
   "java Evil.java",
   "other",
   false,
   false
  ],
  [
   "go run ./cmd",
   "other",
   false,
   false
  ],
  [
   "cargo run",
   "other",
   false,
   false
  ],
  [
   "dotnet run",
   "other",
   false,
   false
  ],
  [
   "poetry run python -c x",
   "other",
   false,
   false
  ],
  [
   "bundle exec ruby -e x",
   "other",
   false,
   false
  ],
  [
   "tmux new 'id'",
   "high",
   false,
   false
  ],
  [
   "screen -dm id",
   "high",
   false,
   false
  ],
  [
   "vim -c ':!id'",
   "other",
   false,
   false
  ],
  [
   "nvim --headless -c '!id'",
   "other",
   false,
   false
  ],
  [
   "emacs --batch --eval x",
   "other",
   false,
   false
  ],
  [
   "open x.command",
   "other",
   false,
   false
  ],
  [
   "script -c id /dev/null",
   "other",
   false,
   false
  ],
  [
   "parallel id ::: 1",
   "other",
   false,
   false
  ],
  [
   "osascript -e x",
   "high",
   false,
   false
  ],
  [
   "launchctl x",
   "high",
   false,
   false
  ],
  [
   "crontab -l",
   "high",
   false,
   false
  ],
  [
   "git log -1 --format='[core]%n fsmonitor = id' --output=.git/config",
   "high",
   false,
   false
  ],
  [
   "git diff --output=src/index.ts",
   "other",
   false,
   true
  ],
  [
   "git show HEAD:x --output=.kete/kete.jsonc",
   "high",
   false,
   false
  ],
  [
   "git log --output .git/config",
   "high",
   false,
   false
  ],
  [
   "git status --output=x",
   "other",
   false,
   true
  ],
  [
   "git rev-parse --output=x",
   "other",
   false,
   true
  ],
  [
   "git blame --output=x f",
   "other",
   false,
   true
  ],
  [
   "(cd; cat Documents/x)",
   "high",
   false,
   false
  ],
  [
   "{ cd; cat Documents/x; }",
   "high",
   false,
   false
  ],
  [
   "if true; then cd; fi; cat Documents/x",
   "other",
   false,
   true
  ],
  [
   "for d in x; do cd; done",
   "other",
   false,
   true
  ],
  [
   "while false; do :; done; cd",
   "high",
   true,
   false
  ],
  [
   "true && cd",
   "high",
   true,
   false
  ],
  [
   "echo x | cd",
   "high",
   true,
   false
  ],
  [
   "cd\tsub",
   "read",
   false,
   true
  ],
  [
   "time cd",
   "high",
   false,
   false
  ],
  [
   "! cd",
   "other",
   false,
   true
  ],
  [
   "case x in x) cd;; esac",
   "high",
   false,
   false
  ],
  [
   "f() { cd; }; f",
   "high",
   false,
   false
  ],
  [
   "x=$(cd; pwd)",
   "high",
   false,
   false
  ],
  [
   "cd ~+",
   "high",
   true,
   false
  ],
  [
   "cd ~-",
   "high",
   true,
   false
  ],
  [
   "pushd +1",
   "high",
   true,
   false
  ],
  [
   "cd \"$OLDPWD\"",
   "high",
   true,
   false
  ],
  [
   "OLDPWD=/ cd -",
   "high",
   true,
   false
  ],
  [
   "cp payload .gi?/config",
   "high",
   false,
   false
  ],
  [
   "cp payload .??t/config",
   "high",
   false,
   false
  ],
  [
   "cp p .[g]it/hooks/pre-commit",
   "high",
   false,
   false
  ],
  [
   "cp -r stage/. .k*",
   "high",
   false,
   false
  ],
  [
   "go build -o .git/hooks/pre-commit ./cmd",
   "high",
   false,
   false
  ],
  [
   "tsc --outDir .kete/plugin",
   "high",
   false,
   false
  ]
]

const paths: ReadonlyArray<readonly [string, boolean, boolean]> = [[".kete/kete.jsonc", true, false], [".KETE/agent/x.md", true, false], ["./.kete//x", true, false], ["a/../.kete/x", true, false], [".git/config", true, false], [".Git/HEAD", true, false], [".git./config", true, false], [".git /config", true, false], ["GIT~1/config", true, false], [".git::$INDEX_ALLOCATION/config", true, false], ["kete.json", true, false], ["KETE.JSONC", true, false], ["sub/kete.json", true, false], ["opencode.json", false, false], [".opencode/agent/x.md", false, false], [".kete\\agent\\x.md", true, false], ["C:\\p\\.kete\\x", true, false], [".gitmodules", false, true], [".gitattributes", false, true], [".gitconfig", false, false], [".git", true, false], [".kete", true, false], [".kete/x", true, false], [".kete​/x", false, false], ["AGENTS.md", false, true], ["CLAUDE.md", false, true], [".vscode/tasks.json", false, true], [".vscode/settings.json", false, false], [".idea/workspace.xml", false, false], [".envrc", false, true], [".tool-versions", false, false], [".mise.toml", false, true], [".nvmrc", false, false]]

const entries: ReadonlyArray<readonly [string, boolean]> = [["package.json", true], ["vitest.workspace.ts", true], ["vitest.workspace.json", true], ["vitest.config.ts", true], ["vite.config.ts", true], ["jest.config.json", true], ["jest.config.js", true], ["jest.setup.js", true], ["jest.config.ts", true], [".babelrc", true], ["babel.config.json", true], [".babelrc.js", true], ["tsconfig.json", false], ["jsconfig.json", false], [".pre-commit-config.yaml", true], ["lefthook.yml", true], [".lefthook.yml", true], ["Rakefile", true], ["composer.json", true], ["Gemfile", true], ["Cargo.toml", true], ["build.rs", true], [".cargo/config.toml", true], ["go.mod", true], ["go.work", true], ["Makefile", true], ["CMakeLists.txt", true], ["meson.build", true], ["BUILD", true], ["BUILD.bazel", true], ["WORKSPACE", true], [".bazelrc", true], ["Justfile", true], ["Taskfile.yml", true], ["pytest.ini", true], ["setup.py", true], ["setup.cfg", true], ["pyproject.toml", true], ["conftest.py", true], ["sub/conftest.py", true], ["tox.ini", true], ["noxfile.py", true], ["manage.py", true], ["Dockerfile", false], ["docker-compose.yml", false], [".mocharc.js", true], [".mocharc.yml", true], ["karma.conf.js", true], ["playwright.config.ts", true], ["cypress.config.ts", true], ["cypress/support/e2e.ts", false], [".eslintrc.js", true], ["eslint.config.mjs", true], [".eslintrc.cjs", true], ["prettier.config.js", true], [".prettierrc.js", true], ["webpack.config.js", true], ["rollup.config.mjs", true], ["next.config.js", true], ["nuxt.config.ts", true], ["svelte.config.js", true], ["astro.config.mjs", true], ["tailwind.config.js", true], ["postcss.config.js", true], ["turbo.json", true], ["nx.json", true], ["project.json", true], ["lerna.json", true], [".npmrc", true], [".yarnrc.yml", true], [".pnpmfile.cjs", true], ["bunfig.toml", true], ["deno.json", true], ["phpunit.xml", true], ["phpunit.xml.dist", true], ["Gruntfile.js", true], ["gulpfile.js", true], ["Gemfile.lock", true], [".rspec", true], ["spec/spec_helper.rb", true], ["test/test_helper.rb", true], [".github/workflows/x.yml", true], [".husky/pre-commit", true], [".gitlab-ci.yml", true], ["Jenkinsfile", true], ["build.gradle", true], ["gradle/wrapper/gradle-wrapper.properties", true], ["gradlew", true], ["mvnw", true], [".mvn/extensions.xml", true], ["pom.xml", true], ["settings.gradle", true], ["build.sbt", true], ["project/plugins.sbt", true], ["mix.exs", true], ["rebar.config", true], ["stack.yaml", true], ["package.yaml", true], ["x.cabal", true], ["Package.swift", true], ["pubspec.yaml", false], ["sitecustomize.py", true], ["usercustomize.py", true], ["x.pth", true], ["__init__.py", false], ["pnpm-lock.yaml", true], ["node_modules/.bin/vitest", true], ["node_modules/x/index.js", true], [".vscode/tasks.json", true], [".envrc", true], [".tool-versions", false], [".nvmrc", false], ["global-setup.ts", true], ["vitest.setup.ts", true], ["test/setup.ts", false], ["jest-preset.js", true], ["x.config.json", false], ["x.config.yaml", false], ["x.config.cjs", true]]


describe("PR #20 re-review repros", () => {
  for (const [command, risk, lineHigh, saveable] of rows)
    test(JSON.stringify(command), () => {
      expect(KeteShellRisk.classify(command).risk).toBe(risk)
      expect(KeteShellRisk.classifyLine(command).risk === "high").toBe(lineHigh)
      expect(KeteShellRisk.saveable(command)).toBe(saveable)
    })

  test("protected paths and entry points", () => {
    for (const [path, isProtected, isEntry] of paths) {
      expect([path, KeteShellRisk.protectedPath(path)]).toEqual([path, isProtected])
      expect([path, KeteShellRisk.entryPoint(path)]).toEqual([path, isEntry])
    }
    for (const [path, isEntry] of entries) expect([path, KeteShellRisk.entryPoint(path)]).toEqual([path, isEntry])
  })

  test("high-risk commands are never saveable", () => {
    for (const [command, risk, , saveable] of rows) if (risk === "high") expect([command, saveable]).toEqual([command, false])
  })
})
