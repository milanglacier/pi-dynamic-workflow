/**
 * Concurrency control and deterministic combinators for workflow scripts.
 */

import * as os from "node:os";

export function defaultConcurrency(): number {
	return Math.max(2, Math.min(8, os.cpus().length - 2));
}

/** Simple counting semaphore capping concurrent subagent subprocesses. */
export class Semaphore {
	private available: number;
	private waiters: Array<() => void> = [];

	constructor(capacity: number) {
		this.available = Math.max(1, capacity);
	}

	async acquire(): Promise<void> {
		if (this.available > 0) {
			this.available--;
			return;
		}
		await new Promise<void>((resolve) => this.waiters.push(resolve));
	}

	release(): void {
		const next = this.waiters.shift();
		if (next) next();
		else this.available++;
	}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await fn();
		} finally {
			this.release();
		}
	}
}

/**
 * Run all thunks concurrently. A thrown/rejected thunk resolves to `null`
 * (the batch never rejects), so scripts can `.filter(Boolean)`.
 */
export async function parallel(thunks: Array<() => Promise<unknown>>): Promise<unknown[]> {
	return Promise.all(
		thunks.map(async (thunk) => {
			try {
				return await thunk();
			} catch {
				return null;
			}
		}),
	);
}

export type PipelineStage = (prev: unknown, item: unknown, index: number) => Promise<unknown> | unknown;

/**
 * Each item flows through all stages independently with no cross-item barrier.
 * A throwing stage drops the item to `null` and skips its remaining stages.
 */
export async function pipeline(items: unknown[], ...stages: PipelineStage[]): Promise<unknown[]> {
	return Promise.all(
		items.map(async (item, index) => {
			let value: unknown = item;
			for (const stage of stages) {
				try {
					value = await stage(value, item, index);
				} catch {
					return null;
				}
			}
			return value;
		}),
	);
}
