import assert from "node:assert";
import { test } from "node:test";
import { defaultConcurrency, parallel, pipeline, Semaphore } from "../src/scheduler.ts";

test("parallel: failures resolve to null, batch never rejects", async () => {
	const results = await parallel([
		async () => "ok",
		async () => {
			throw new Error("boom");
		},
		async () => 42,
	]);
	assert.deepStrictEqual(results, ["ok", null, 42]);
});

test("parallel: empty input", async () => {
	assert.deepStrictEqual(await parallel([]), []);
});

test("pipeline: stages receive (prev, item, index); throwing stage drops item and skips rest", async () => {
	const seen: string[] = [];
	const results = await pipeline(
		["a", "b"],
		(_, item) => {
			if (item === "b") throw new Error("drop b");
			return `${item}1`;
		},
		(prev, item, i) => {
			seen.push(`${prev}:${item}:${i}`);
			return `${prev}2`;
		},
	);
	assert.deepStrictEqual(results, ["a12", null]);
	assert.deepStrictEqual(seen, ["a1:a:0"]);
});

test("pipeline: no stages returns items unchanged", async () => {
	assert.deepStrictEqual(await pipeline([1, 2]), [1, 2]);
});

test("semaphore caps concurrency and releases on throw", async () => {
	const sem = new Semaphore(2);
	let active = 0;
	let peak = 0;
	await Promise.allSettled(
		Array.from({ length: 6 }, (_, i) =>
			sem.run(async () => {
				active++;
				peak = Math.max(peak, active);
				await new Promise((r) => setTimeout(r, 10));
				active--;
				if (i % 2 === 0) throw new Error("release check");
			}),
		),
	);
	assert.strictEqual(peak, 2);
	assert.strictEqual(active, 0);
	// Capacity fully restored: two more can run concurrently.
	let again = 0;
	await Promise.all([
		sem.run(async () => {
			again++;
			await new Promise((r) => setTimeout(r, 5));
		}),
		sem.run(async () => {
			again++;
			await new Promise((r) => setTimeout(r, 5));
		}),
	]);
	assert.strictEqual(again, 2);
});

test("defaultConcurrency stays within [2, 8]", () => {
	const n = defaultConcurrency();
	assert.ok(n >= 2 && n <= 8, `got ${n}`);
});
