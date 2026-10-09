package publish

import (
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/bundle"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/gitproto"
)

// The platform's checkAgainstBase cases (apps/portal/lib/jobs/push/base-tree.ts), on hand-built
// listings.
func TestCheckAgainstBase(t *testing.T) {
	sha := func(c byte) string {
		b := make([]byte, 40)
		for i := range b {
			b[i] = c
		}
		return string(b)
	}
	listings := map[string][]gitproto.TreeEntry{
		"": {
			{Mode: "100644", Name: "README.md", SHA: sha('1')}, {Mode: "120000", Name: "link", SHA: sha('2')},
			{Mode: "160000", Name: "vendor", SHA: sha('3')}, {Mode: "40000", Name: "src", SHA: sha('4')},
			{Mode: "40000", Name: "Docs", SHA: sha('5')}, {Mode: "100755", Name: "run.sh", SHA: sha('6')},
			{Mode: "100644", Name: "café.txt", SHA: sha('7')},
		},
		"src": {{Mode: "100644", Name: "app.go", SHA: sha('8')}},
	}
	file := func(p string) bundle.Entry { return bundle.Entry{Path: p, Mode: "100644"} }
	del := func(p string) bundle.Entry { return bundle.Entry{Path: p, Deleted: true} }
	for _, tc := range []struct {
		e    bundle.Entry
		want string
	}{
		{file("README.md"), ""},
		{file("src/app.go"), ""},
		{file("src/new/deep.go"), ""},
		{file("new/dir/file"), ""},
		{del("run.sh"), ""},
		{file("link"), "symlink"},
		{del("link"), "symlink"},
		{file("vendor"), "submodule"},
		{file("src"), "path_is_directory"},
		{del("src"), "deletion_not_blob"},
		{del("missing.txt"), "deletion_not_blob"},
		{del("nodir/x"), "deletion_not_blob"},
		{file("README.md/x"), "ancestor_not_directory"},
		{file("readme.md"), "case_collision_base"},
		{file("docs/a.md"), "case_collision_base"},
		{file("SRC/x.go"), "case_collision_base"},
		{file("café.txt"), "case_collision_base"},
	} {
		listingsCopy := listings
		if got := checkAgainstBase(listingsCopy, []bundle.Entry{tc.e}); got != tc.want {
			t.Errorf("%s (deleted %v): %q, want %q", tc.e.Path, tc.e.Deleted, got, tc.want)
		}
	}
}
