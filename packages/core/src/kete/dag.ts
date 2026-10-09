// The DAG check every Kete DAG uses (Kahn's algorithm, in waves): the `workflow` tool's steps
// (kete/workflows.ts) and an orchestration's plan revisions (kete/orchestration/contract.ts, the
// `orchestrate` tool). Pure.

export * as KeteDag from "./dag.js"

/**
 * Orders `nodes` so each comes after its dependencies: wave by wave, each wave every node whose
 * dependencies are all placed, in the order given. Only edges between listed nodes count (a
 * dependency that isn't listed, or a node naming itself, is the caller's to report). `cycle` is what
 * is left: every node on a cycle or behind one, in the order given.
 */
export function order<K>(nodes: ReadonlyArray<readonly [K, Iterable<K>]>): {
  readonly order: K[]
  readonly cycle: K[]
} {
  const listed = new Set(nodes.map(([key]) => key))
  const remaining = new Map(
    nodes.map(([key, deps]) => [key, new Set([...deps].filter((d) => d !== key && listed.has(d)))]),
  )
  const ordered: K[] = []
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, deps]) => deps.size === 0).map(([key]) => key)
    if (ready.length === 0) break
    for (const key of ready) {
      remaining.delete(key)
      ordered.push(key)
      for (const deps of remaining.values()) deps.delete(key)
    }
  }
  return { order: ordered, cycle: [...remaining.keys()] }
}
