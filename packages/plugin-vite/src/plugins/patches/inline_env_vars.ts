import type { NodePath, PluginObj, types } from "@babel/core";

export function inlineEnvVarsPlugin(mode: string, env: Record<string, string>) {
  const allowed = new Map<string, string>();
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("FRESH_PUBLIC_")) {
      allowed.set(name, value);
    }
  }

  allowed.set("NODE_ENV", mode);

  return ({ types: t }: { types: typeof types }): PluginObj => {
    function isWritePosition(path: NodePath<types.MemberExpression>): boolean {
      const parent = path.parentPath?.node;
      if (!parent) return false;

      // LHS of assignment: process.env.FOO = "bar"
      if (t.isAssignmentExpression(parent) && parent.left === path.node) {
        return true;
      }

      // Update expressions: ++process.env.FOO, process.env.FOO++
      if (t.isUpdateExpression(parent) && parent.argument === path.node) {
        return true;
      }

      // delete process.env.FOO
      if (t.isUnaryExpression(parent) && parent.operator === "delete") {
        return true;
      }

      // for (process.env.FOO in obj) / for (process.env.FOO of obj)
      if (
        (t.isForInStatement(parent) || t.isForOfStatement(parent)) &&
        (parent as any).left === path.node
      ) {
        return true;
      }

      return false;
    }

    function safeReplace(path: NodePath, name: string) {
      // Only inline when the member/call result is being READ (referenced),
      // not when it appears in a write/mutate position.
      const isReferenced =
        "isReferenced" in path &&
        typeof (path as any).isReferenced === "function"
          ? (path as any).isReferenced()
          : true;

      if (!isReferenced) return;

      if (allowed.has(name)) {
        const value = allowed.get(name);

        if (value !== undefined) {
          // Replace with a string literal value
          (path as NodePath).replaceWith(t.stringLiteral(value));
        } else {
          // Explicit undefined if the key exists but value is undefined
          (path as NodePath).replaceWith(t.identifier("undefined"));
        }
      }
    }

    return {
      name: "fresh-env-var",
      visitor: {
        MemberExpression(path) {
          // Skip if this member expression is being written to / mutated.
          if (isWritePosition(path)) return;

          // Check: process.env.*
          if (
            t.isMemberExpression(path.node.object) &&
            t.isIdentifier(path.node.object.object) &&
            path.node.object.object.name === "process" &&
            t.isIdentifier(path.node.object.property) &&
            path.node.object.property.name === "env" &&
            t.isIdentifier(path.node.property)
          ) {
            const name = path.node.property.name;
            safeReplace(path, name);
            return;
          }

          // Check: import.meta.env.*
          if (
            t.isIdentifier(path.node.property) &&
            t.isMemberExpression(path.node.object) &&
            t.isIdentifier(path.node.object.property) &&
            path.node.object.property.name === "env" &&
            t.isMetaProperty(path.node.object.object)
          ) {
            const name = path.node.property.name;
            safeReplace(path, name);
            return;
          }
        },

        CallExpression(path) {
          // Check: Deno.env.get("<string>")
          if (
            t.isMemberExpression(path.node.callee) &&
            t.isMemberExpression(path.node.callee.object) &&
            t.isIdentifier(path.node.callee.object.object) &&
            path.node.callee.object.object.name === "Deno" &&
            t.isIdentifier(path.node.callee.object.property) &&
            path.node.callee.object.property.name === "env" &&
            t.isIdentifier(path.node.callee.property) &&
            path.node.callee.property.name === "get" &&
            path.node.arguments.length > 0 &&
            t.isStringLiteral(path.node.arguments[0])
          ) {
            const name = (path.node.arguments[0] as types.StringLiteral).value;
            // CallExpression is a read position by nature; safe to inline.
            safeReplace(path, name);
          }
        },
      },
    };
  };
}
