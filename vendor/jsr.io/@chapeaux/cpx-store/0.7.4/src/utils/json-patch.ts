/** An RFC 6902 JSON Patch operation. */
export interface PatchOp { op: 'add' | 'remove' | 'replace'; path: string; value?: unknown }

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Computes RFC 6902 patch operations between two plain objects, up to one level of nesting. */
export function diffObjects(oldObj: Record<string, unknown>, newObj: Record<string, unknown>): PatchOp[] {
  const ops: PatchOp[] = [];
  const oldKeys = new Set(Object.keys(oldObj));
  const newKeys = new Set(Object.keys(newObj));
  for (const key of oldKeys) {
    if (!newKeys.has(key)) ops.push({ op: 'remove', path: `/${key}` });
  }
  for (const key of newKeys) {
    const ov = oldObj[key], nv = newObj[key];
    if (!oldKeys.has(key)) { ops.push({ op: 'add', path: `/${key}`, value: nv }); continue; }
    if (isObj(ov) && isObj(nv)) {
      const ik = new Set(Object.keys(ov)), nk = new Set(Object.keys(nv));
      for (const k of ik) if (!nk.has(k)) ops.push({ op: 'remove', path: `/${key}/${k}` });
      for (const k of nk) {
        if (!ik.has(k)) ops.push({ op: 'add', path: `/${key}/${k}`, value: nv[k] });
        else if (!Object.is(ov[k], nv[k])) ops.push({ op: 'replace', path: `/${key}/${k}`, value: nv[k] });
      }
    } else if (!Object.is(ov, nv)) {
      ops.push({ op: 'replace', path: `/${key}`, value: nv });
    }
  }
  return ops;
}

/** Applies an array of patch operations to an object and returns a new object. */
export function applyPatch(obj: Record<string, unknown>, ops: PatchOp[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) result[k] = isObj(obj[k]) ? { ...(obj[k] as Record<string, unknown>) } : obj[k];
  for (const { op, path, value } of ops) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 1) {
      if (op === 'remove') delete result[parts[0]]; else result[parts[0]] = value;
    } else {
      const parent = result[parts[0]] as Record<string, unknown>;
      if (op === 'remove') delete parent[parts[1]]; else parent[parts[1]] = value;
    }
  }
  return result;
}

/** Generates the reverse patch operations needed to undo a forward patch. */
export function reversePatch(oldObj: Record<string, unknown>, ops: PatchOp[]): PatchOp[] {
  return ops.map(({ op, path }) => {
    const parts = path.split('/').filter(Boolean);
    const ov = parts.length === 1 ? oldObj[parts[0]] : (oldObj[parts[0]] as Record<string, unknown>)?.[parts[1]];
    if (op === 'add') return { op: 'remove' as const, path };
    if (op === 'remove') return { op: 'add' as const, path, value: ov };
    return { op: 'replace' as const, path, value: ov };
  });
}
