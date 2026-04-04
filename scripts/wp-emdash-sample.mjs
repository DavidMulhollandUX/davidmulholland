#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function fail(message) {
	console.error(`\n[wp-emdash-sample] ${message}`);
	process.exit(1);
}

function env(name) {
	const value = process.env[name]?.trim();
	if (!value) {
		fail(`Missing required env var: ${name}`);
	}
	return value;
}

function normalizeEndpoint() {
	const explicit = process.env.WP_EMDASH_API_ENDPOINT?.trim();
	if (explicit) return explicit.replace(/\/$/, "");
	const baseUrl = env("WP_EMDASH_BASE_URL");
	return `${baseUrl.replace(/\/$/, "")}/wp-json/emdash/v1`;
}

function authHeader() {
	const username = env("WP_EMDASH_USERNAME");
	const appPassword = env("WP_EMDASH_APP_PASSWORD");
	const encoded = Buffer.from(`${username}:${appPassword}`, "utf8").toString("base64");
	return `Basic ${encoded}`;
}

async function fetchJson(url, authorization) {
	const response = await fetch(url, {
		headers: { Authorization: authorization },
	});
	const text = await response.text();
	const json = text ? JSON.parse(text) : null;
	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText} -> ${url}`);
	}
	return json;
}

function stripItem(item) {
	if (!item || typeof item !== "object") return item;
	return {
		id: item.id ?? null,
		slug: item.slug ?? null,
		title: item.title ?? item.name ?? null,
		status: item.status ?? null,
		date: item.date ?? item.modified ?? null,
		featured_media: item.featured_media ?? item.featuredMedia ?? null,
		seo: item.seo ? "present" : "none",
	};
}

function arrayFromPayload(payload) {
	if (Array.isArray(payload)) return payload;
	if (payload && typeof payload === "object") {
		return payload.items ?? payload.data ?? payload.posts ?? payload.pages ?? payload.media ?? [];
	}
	return [];
}

async function main() {
	const endpoint = normalizeEndpoint();
	const authorization = authHeader();
	const sampleSize = Number.parseInt(process.env.WP_EMDASH_SAMPLE_SIZE ?? "5", 10);
	if (Number.isNaN(sampleSize) || sampleSize < 1 || sampleSize > 50) {
		fail("WP_EMDASH_SAMPLE_SIZE must be between 1 and 50.");
	}

	console.log("\n[wp-emdash-sample] Pulling sample data from exporter...");
	console.log(`[wp-emdash-sample] Endpoint: ${endpoint}`);
	console.log(`[wp-emdash-sample] Sample size: ${sampleSize}`);

	const [postsRaw, pagesRaw, mediaRaw, taxonomiesRaw, optionsRaw] = await Promise.all([
		fetchJson(`${endpoint}/content?post_type=post&page=1&per_page=${sampleSize}`, authorization),
		fetchJson(`${endpoint}/content?post_type=page&page=1&per_page=${sampleSize}`, authorization),
		fetchJson(`${endpoint}/media?page=1&per_page=${sampleSize}`, authorization),
		fetchJson(`${endpoint}/taxonomies`, authorization),
		fetchJson(`${endpoint}/options`, authorization),
	]);

	const posts = arrayFromPayload(postsRaw).map(stripItem);
	const pages = arrayFromPayload(pagesRaw).map(stripItem);
	const media = arrayFromPayload(mediaRaw).map(stripItem);
	const taxonomies = Array.isArray(taxonomiesRaw)
		? taxonomiesRaw
		: Object.keys(taxonomiesRaw ?? {}).map((key) => ({ taxonomy: key }));

	const report = {
		timestamp: new Date().toISOString(),
		endpoint,
		sampleSize,
		summary: {
			posts: posts.length,
			pages: pages.length,
			media: media.length,
			taxonomies: taxonomies.length,
			optionsKeys: optionsRaw && typeof optionsRaw === "object" ? Object.keys(optionsRaw).length : 0,
		},
		sample: {
			posts,
			pages,
			media,
			taxonomies,
		},
		raw: {
			posts: postsRaw,
			pages: pagesRaw,
			media: mediaRaw,
			taxonomies: taxonomiesRaw,
			options: optionsRaw,
		},
	};

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outDir = resolve(process.cwd(), ".migration");
	await mkdir(outDir, { recursive: true });
	const outFile = resolve(outDir, `wp-emdash-sample-${timestamp}.json`);
	await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");

	console.log("[wp-emdash-sample] Success. Report written:");
	console.log(outFile);
}

main().catch((error) => {
	fail(error instanceof Error ? error.message : String(error));
});
