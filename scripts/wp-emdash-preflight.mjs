#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const REQUIRED_ENV = ["WP_EMDASH_USERNAME", "WP_EMDASH_APP_PASSWORD"];

function fail(message) {
	console.error(`\n[wp-emdash-preflight] ${message}`);
	process.exit(1);
}

function getEndpoint() {
	const explicit = process.env.WP_EMDASH_API_ENDPOINT;
	if (explicit && explicit.trim()) {
		return explicit.trim().replace(/\/$/, "");
	}

	const base = process.env.WP_EMDASH_BASE_URL;
	if (!base || !base.trim()) {
		fail("Set WP_EMDASH_API_ENDPOINT or WP_EMDASH_BASE_URL.");
	}

	return `${base.trim().replace(/\/$/, "")}/wp-json/emdash/v1`;
}

function getAuthHeader() {
	for (const key of REQUIRED_ENV) {
		if (!process.env[key]?.trim()) {
			fail(`Missing required env var: ${key}`);
		}
	}

	const username = process.env.WP_EMDASH_USERNAME;
	const appPassword = process.env.WP_EMDASH_APP_PASSWORD;
	const encoded = Buffer.from(`${username}:${appPassword}`, "utf8").toString("base64");
	return `Basic ${encoded}`;
}

async function fetchJson(url, { headers = {}, requiredAuth = false } = {}) {
	const response = await fetch(url, { headers });
	const text = await response.text();

	let json;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = { raw: text };
	}

	if (!response.ok) {
		const details = typeof json === "object" ? JSON.stringify(json) : String(json);
		const authHint = requiredAuth ? " (check username/application password)" : "";
		throw new Error(`${response.status} ${response.statusText}${authHint} -> ${url}\n${details}`);
	}

	return json;
}

function summarizeAnalyze(analyze) {
	if (!analyze || typeof analyze !== "object") {
		return { note: "Analyze endpoint returned unexpected format." };
	}

	const counts = analyze.counts ?? analyze.summary ?? analyze.stats ?? null;
	const postTypes = analyze.post_types ?? analyze.postTypes ?? null;
	return {
		siteName: analyze.site_name ?? analyze.siteName ?? null,
		wordpressVersion: analyze.wordpress_version ?? analyze.wordpressVersion ?? null,
		pluginVersion: analyze.plugin_version ?? analyze.pluginVersion ?? null,
		counts,
		postTypes,
	};
}

function summarizeCollection(data) {
	if (Array.isArray(data)) {
		return { totalItemsInResponse: data.length };
	}
	if (data && typeof data === "object") {
		const items = data.items ?? data.posts ?? data.pages ?? data.data;
		const total = Array.isArray(items) ? items.length : undefined;
		return {
			totalItemsInResponse: total ?? null,
			totalAvailable: data.total ?? data.total_items ?? data.totalItems ?? null,
		};
	}
	return { note: "Unexpected format." };
}

async function main() {
	const endpoint = getEndpoint();
	const authHeader = getAuthHeader();

	console.log("\n[wp-emdash-preflight] Running preflight checks...");
	console.log(`[wp-emdash-preflight] Endpoint: ${endpoint}`);

	const probe = await fetchJson(`${endpoint}/probe`);
	const analyze = await fetchJson(`${endpoint}/analyze`, {
		headers: { Authorization: authHeader },
		requiredAuth: true,
	});
	const posts = await fetchJson(`${endpoint}/content?post_type=post&page=1&per_page=3`, {
		headers: { Authorization: authHeader },
		requiredAuth: true,
	});
	const pages = await fetchJson(`${endpoint}/content?post_type=page&page=1&per_page=3`, {
		headers: { Authorization: authHeader },
		requiredAuth: true,
	});
	const media = await fetchJson(`${endpoint}/media?page=1&per_page=3`, {
		headers: { Authorization: authHeader },
		requiredAuth: true,
	});
	const taxonomies = await fetchJson(`${endpoint}/taxonomies`, {
		headers: { Authorization: authHeader },
		requiredAuth: true,
	});
	const options = await fetchJson(`${endpoint}/options`, {
		headers: { Authorization: authHeader },
		requiredAuth: true,
	});

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outDir = resolve(process.cwd(), ".migration");
	await mkdir(outDir, { recursive: true });

	const report = {
		timestamp: new Date().toISOString(),
		endpoint,
		result: "ok",
		summary: {
			probe: {
				siteName: probe?.site_name ?? probe?.siteName ?? null,
				wordpressVersion: probe?.wordpress_version ?? probe?.wordpressVersion ?? null,
				pluginVersion: probe?.plugin_version ?? probe?.pluginVersion ?? null,
			},
			analyze: summarizeAnalyze(analyze),
			posts: summarizeCollection(posts),
			pages: summarizeCollection(pages),
			media: summarizeCollection(media),
			taxonomies: summarizeCollection(taxonomies),
			options: { keys: options && typeof options === "object" ? Object.keys(options).length : null },
		},
		raw: { probe, analyze, posts, pages, media, taxonomies, options },
	};

	const outFile = resolve(outDir, `wp-emdash-preflight-${timestamp}.json`);
	await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");

	console.log("[wp-emdash-preflight] Success. Report written:");
	console.log(outFile);
}

main().catch((error) => {
	fail(error instanceof Error ? error.message : String(error));
});
