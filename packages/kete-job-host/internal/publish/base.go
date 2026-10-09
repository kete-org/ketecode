package publish

// The base tree checks (ADR 0021 rule 6 "the base tree", the platform's
// `apps/portal/lib/jobs/push/base-tree.ts` checkAgainstBase and the Harness provider's readBase):
// listings of the base commit's root and of every existing directory a bundle entry sits in, built
// from one blob-less fetch, only from trees whose entries reproduce them byte for byte; then the
// conflicts that make a bundle unpublishable on this base.

import (
	"sort"
	"strings"

	"golang.org/x/text/unicode/norm"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/bundle"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/gitproto"
)

// maxListings is the platform's PUSH_MAX_LISTINGS.
const maxListings = 300

// listingFailure is why listings couldn't be built: "too_many_directories" (refused),
// "base_tree_truncated" or "invalid_response" (failed).
type listingFailure string

// baseListings builds the listings for the entries' directories from the fetched objects.
func baseListings(f gitproto.BaseFetch, entries []bundle.Entry) (map[string][]gitproto.TreeEntry, listingFailure) {
	listings := map[string][]gitproto.TreeEntry{}
	list := func(path, sha string) listingFailure {
		if len(listings) >= maxListings {
			return "too_many_directories"
		}
		obj, ok := f.Objects[sha]
		if !ok || obj.Type != "tree" {
			return "base_tree_truncated"
		}
		items, ok := gitproto.ParseCanonicalTree(obj.Data)
		if !ok {
			return "invalid_response"
		}
		listings[path] = items
		return ""
	}
	if r := list("", f.Tree); r != "" {
		return nil, r
	}
	wanted := map[string]bool{}
	for _, e := range entries {
		for _, d := range gitproto.DirectoriesOf(e.Path) {
			wanted[d] = true
		}
	}
	dirs := make([]string, 0, len(wanted))
	for d := range wanted {
		dirs = append(dirs, d)
	}
	sort.Slice(dirs, func(i, j int) bool {
		di, dj := strings.Count(dirs[i], "/"), strings.Count(dirs[j], "/")
		if di != dj {
			return di < dj
		}
		return dirs[i] < dirs[j]
	})
	for _, d := range dirs {
		parent, ok := listings[gitproto.ParentOf(d)]
		if !ok {
			continue
		}
		name := gitproto.BaseName(d)
		for _, e := range parent {
			if e.Name == name && e.Mode == "40000" {
				if r := list(d, e.SHA); r != "" {
					return nil, r
				}
				break
			}
		}
	}
	return listings, ""
}

// checkAgainstBase is the platform's checkAgainstBase: the first conflict, or "". Codes:
// case_collision_base, ancestor_not_directory, symlink, submodule, path_is_directory,
// deletion_not_blob.
func checkAgainstBase(listings map[string][]gitproto.TreeEntry, entries []bundle.Entry) string {
	for _, entry := range entries {
		parts := strings.Split(entry.Path, "/")
		dir := ""
		for i, name := range parts {
			listing, ok := listings[dir]
			last := i == len(parts)-1
			if !ok {
				if last && entry.Deleted {
					return "deletion_not_blob"
				}
				break
			}
			var exact *gitproto.TreeEntry
			folded := bundle.Fold(norm.NFC.String(name))
			for j := range listing {
				e := &listing[j]
				if e.Name == name {
					exact = e
				} else if bundle.Fold(norm.NFC.String(e.Name)) == folded {
					return "case_collision_base"
				}
			}
			if !last {
				if exact != nil && exact.Mode != "40000" {
					return "ancestor_not_directory"
				}
				if exact == nil {
					if entry.Deleted {
						return "deletion_not_blob"
					}
					break
				}
				if dir == "" {
					dir = name
				} else {
					dir += "/" + name
				}
				continue
			}
			if exact != nil {
				switch {
				case exact.Mode == "120000":
					return "symlink"
				case exact.Mode == "160000":
					return "submodule"
				case exact.Mode == "40000":
					if entry.Deleted {
						return "deletion_not_blob"
					}
					return "path_is_directory"
				case entry.Deleted && exact.Mode != "100644" && exact.Mode != "100755":
					return "deletion_not_blob"
				}
			} else if entry.Deleted {
				return "deletion_not_blob"
			}
		}
	}
	return ""
}
