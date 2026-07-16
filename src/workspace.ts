/**
 * Workspace — root directory for all tool operations.
 *
 * Every tool call is scoped to this directory (or a subdirectory via `cwd`).
 * Set via MAVIS_WORKSPACE env var, or pass to createWorkspace() at startup.
 */

import { resolve, isAbsolute, sep } from 'node:path';
import { existsSync, statSync } from 'node:fs';

export class WorkspaceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WorkspaceError';
    }
}

/**
 * Workspace object. Immutable once created.
 */
export interface Workspace {
    /** Absolute path to the workspace root. */
    readonly root: string;
    /** Resolve a subpath (cwd) to an absolute path within the workspace. */
    resolve(cwd?: string): string;
    /** Check if a path is within the workspace (defense against escape). */
    contains(absolutePath: string): boolean;
}

/**
 * Create a workspace from an absolute path.
 * Throws if the path doesn't exist or isn't a directory.
 */
export function createWorkspace(rootPath: string): Workspace {
    const root = resolve(rootPath);

    if (!existsSync(root)) {
        throw new WorkspaceError(`Workspace root does not exist: ${root}`);
    }
    const stat = statSync(root);
    if (!stat.isDirectory()) {
        throw new WorkspaceError(`Workspace root is not a directory: ${root}`);
    }

    return {
        root,
        resolve(cwd?: string): string {
            if (!cwd || cwd === '.') return root;
            // Always resolve relative to workspace root, never absolute escape.
            const target = isAbsolute(cwd) ? cwd : resolve(root, cwd);
            if (!target.startsWith(root + sep) && target !== root) {
                throw new WorkspaceError(
                    `Path escapes workspace: ${cwd} (resolved to ${target})`
                );
            }
            return target;
        },
        contains(absolutePath: string): boolean {
            return absolutePath === root || absolutePath.startsWith(root + sep);
        }
    };
}

/**
 * Load workspace from environment.
 * Priority: MAVIS_WORKSPACE env var.
 */
export function workspaceFromEnv(): Workspace {
    const root = process.env.MAVIS_WORKSPACE;
    if (!root) {
        throw new WorkspaceError(
            'MAVIS_WORKSPACE env var is required. ' +
            'Set it to the absolute path of your project directory.'
        );
    }
    return createWorkspace(root);
}
