#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

function fail(message) {
	console.error(`\n[wp-emdash-to-seed] ${message}`);
	process.exit(1);
}

function envOrDefault(name, fallback) {
	const value = process.env[name]?.trim();
	return value || fallback;
}

function requiredEnv(name) {
	const value = process.env[name]?.trim();
	if (!value) fail(`Missing required env var: ${name}`);
	return value;
}

function endpointFromEnv() {
	const endpoint = process.env.WP_EMDASH_API_ENDPOINT?.trim();
	if (endpoint) return endpoint.replace(/\/$/, "");
	const base = requiredEnv("WP_EMDASH_BASE_URL");
	return `${base.replace(/\/$/, "")}/wp-json/emdash/v1`;
}

function basicAuthHeader() {
	const username = requiredEnv("WP_EMDASH_USERNAME");
	const appPassword = requiredEnv("WP_EMDASH_APP_PASSWORD");
	const encoded = Buffer.from(`${username}:${appPassword}`, "utf8").toString("base64");
	return `Basic ${encoded}`;
}

async function fetchJson(url, headers) {
	const response = await fetch(url, { headers });
	const body = await response.text();
	let payload;
	try {
		payload = body ? JSON.parse(body) : null;
	} catch {
		payload = body;
	}
	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText} -> ${url}`);
	}
	return payload;
}

function asArray(payload) {
	if (Array.isArray(payload)) return payload;
	if (!payload || typeof payload !== "object") return [];
	return payload.items ?? payload.data ?? payload.posts ?? payload.pages ?? payload.results ?? [];
}

async function fetchPaginatedContent(endpoint, headers, postType, perPage) {
	const items = [];
	for (let page = 1; page <= 1000; page += 1) {
		const url = `${endpoint}/content?post_type=${encodeURIComponent(postType)}&page=${page}&per_page=${perPage}`;
		const payload = await fetchJson(url, headers);
		const pageItems = asArray(payload);
		if (pageItems.length === 0) break;
		items.push(...pageItems);
		if (pageItems.length < perPage) break;
	}
	return items;
}

function cleanText(text) {
	if (!text) return "";
	return String(text)
		.replace(/<\s*br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function htmlToPortableText(html) {
	const text = cleanText(html);
	if (!text) return [];
	const paragraphs = text
		.split(/\n\n+/)
		.map((p) => p.trim())
		.filter(Boolean);

	return paragraphs.map((paragraph) => ({
		_type: "block",
		style: "normal",
		children: [{ _type: "span", text: paragraph }],
	}));
}

function getTitle(item) {
	if (!item || typeof item !== "object") return "Untitled";
	if (typeof item.title === "string") return item.title;
	if (item.title && typeof item.title === "object") {
		return item.title.rendered ?? item.title.raw ?? "Untitled";
	}
	return "Untitled";
}

function getExcerpt(item) {
	if (!item || typeof item !== "object") return "";
	if (typeof item.excerpt === "string") return cleanText(item.excerpt);
	if (item.excerpt && typeof item.excerpt === "object") {
		return cleanText(item.excerpt.rendered ?? item.excerpt.raw ?? "");
	}
	return "";
}

function getContentHtml(item) {
	if (!item || typeof item !== "object") return "";
	if (typeof item.content === "string") return item.content;
	if (item.content && typeof item.content === "object") {
		return item.content.rendered ?? item.content.raw ?? "";
	}
	return "";
}

function normalizeStatus(status) {
	return status === "publish" || status === "published" ? "published" : "draft";
}

function mediaFieldFromItem(item) {
	const featured = item?.featured_media_data ?? item?.featured_image ?? item?.featuredMedia;
	if (!featured || typeof featured !== "object") return undefined;
	const url = featured.url ?? featured.source_url ?? featured.src;
	if (!url) return undefined;
	const filename = featured.filename ?? basename(new URL(url).pathname || "image.jpg");
	const alt = featured.alt ?? featured.alt_text ?? "";
	return {
		$media: {
			url,
			alt,
			filename,
		},
	};
}

function slugifyTerm(input) {
	return String(input)
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "term";
}

function collectTaxonomyTerms(posts) {
	const categories = new Map();
	const tags = new Map();

	for (const post of posts) {
		const terms = post?.terms ?? post?.taxonomies ?? {};
		const cats = terms.category ?? terms.categories ?? [];
		const tgs = terms.tag ?? terms.tags ?? [];

		for (const c of cats) {
			const slug = typeof c === "string" ? slugifyTerm(c) : c.slug ?? slugifyTerm(c.name ?? c.label ?? "category");
			const label = typeof c === "string" ? c : c.name ?? c.label ?? slug;
			categories.set(slug, label);
		}
		for (const t of tgs) {
			const slug = typeof t === "string" ? slugifyTerm(t) : t.slug ?? slugifyTerm(t.name ?? t.label ?? "tag");
			const label = typeof t === "string" ? t : t.name ?? t.label ?? slug;
			tags.set(slug, label);
		}
	}

	return {
		categories: [...categories.entries()].map(([slug, label]) => ({ slug, label })),
		tags: [...tags.entries()].map(([slug, label]) => ({ slug, label })),
	};
}

function extractPostTaxonomies(post) {
	const terms = post?.terms ?? post?.taxonomies ?? {};
	const categories = (terms.category ?? terms.categories ?? []).map((c) =>
		typeof c === "string" ? slugifyTerm(c) : c.slug ?? slugifyTerm(c.name ?? c.label ?? "category"),
	);
	const tags = (terms.tag ?? terms.tags ?? []).map((t) =>
		typeof t === "string" ? slugifyTerm(t) : t.slug ?? slugifyTerm(t.name ?? t.label ?? "tag"),
	);
	const result = {};
	if (categories.length) result.category = Array.from(new Set(categories));
	if (tags.length) result.tag = Array.from(new Set(tags));
	return result;
}

function mapPosts(posts) {
	return posts.map((post) => {
		const slug = post.slug ?? `post-${post.id}`;
		const featuredImage = mediaFieldFromItem(post);
		const entry = {
			id: `wp-post-${post.id ?? slug}`,
			slug,
			status: normalizeStatus(post.status),
			data: {
				title: getTitle(post),
				excerpt: getExcerpt(post),
				content: htmlToPortableText(getContentHtml(post)),
			},
		};
		if (featuredImage) {
			entry.data.featured_image = featuredImage;
		}
		const taxonomies = extractPostTaxonomies(post);
		if (Object.keys(taxonomies).length > 0) {
			entry.taxonomies = taxonomies;
		}
		return entry;
	});
}

function mapPages(pages) {
	return pages.map((page) => ({
		id: `wp-page-${page.id ?? page.slug ?? "page"}`,
		slug: page.slug ?? `page-${page.id}`,
		status: normalizeStatus(page.status),
		data: {
			title: getTitle(page),
			content: htmlToPortableText(getContentHtml(page)),
		},
	}));
}

async function main() {
	const endpoint = endpointFromEnv();
	const perPage = Number.parseInt(envOrDefault("WP_EMDASH_IMPORT_PER_PAGE", "100"), 10);
	if (Number.isNaN(perPage) || perPage < 1 || perPage > 200) {
		fail("WP_EMDASH_IMPORT_PER_PAGE must be between 1 and 200.");
	}

	const auth = basicAuthHeader();
	const headers = { Authorization: auth };

	console.log(`[wp-emdash-to-seed] Source endpoint: ${endpoint}`);
	console.log(`[wp-emdash-to-seed] Fetching posts/pages with per_page=${perPage}...`);

	const [postsRaw, pagesRaw] = await Promise.all([
		fetchPaginatedContent(endpoint, headers, "post", perPage),
		fetchPaginatedContent(endpoint, headers, "page", perPage),
	]);

	console.log(`[wp-emdash-to-seed] Fetched ${postsRaw.length} posts and ${pagesRaw.length} pages.`);

	const existingSeedPath = resolve(process.cwd(), "seed/seed.json");
	const outputSeedPath = resolve(process.cwd(), "seed/seed.wp-import.json");
	const migrationDir = resolve(process.cwd(), ".migration");

	const existingSeed = JSON.parse(await readFile(existingSeedPath, "utf8"));
	const seed = structuredClone(existingSeed);

	const mappedPosts = mapPosts(postsRaw);
	const mappedPages = mapPages(pagesRaw);
	const termSets = collectTaxonomyTerms(postsRaw);

	seed.meta = {
		...(seed.meta ?? {}),
		name: "WordPress Import",
		description: `Imported from ${endpoint}`,
		author: "WP EmDash Importer",
	};

	if (Array.isArray(seed.taxonomies)) {
		for (const taxonomy of seed.taxonomies) {
			if (taxonomy.name === "category") taxonomy.terms = termSets.categories;
			if (taxonomy.name === "tag") taxonomy.terms = termSets.tags;
		}
	}

	seed.content = {
		...(seed.content ?? {}),
		posts: mappedPosts,
		pages: mappedPages,
	};

	await mkdir(migrationDir, { recursive: true });
	await writeFile(outputSeedPath, `${JSON.stringify(seed, null, 2)}\n`, "utf8");

	const summaryPath = resolve(migrationDir, "wp-import-summary.json");
	await writeFile(
		summaryPath,
		`${JSON.stringify(
			{
				timestamp: new Date().toISOString(),
				sourceEndpoint: endpoint,
				imported: {
					posts: mappedPosts.length,
					pages: mappedPages.length,
					categories: termSets.categories.length,
					tags: termSets.tags.length,
				},
				outputSeedPath,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);

	console.log("[wp-emdash-to-seed] Wrote import seed:");
	console.log(outputSeedPath);
	console.log("[wp-emdash-to-seed] Wrote summary:");
	console.log(summaryPath);
}

main().catch((error) => {
	fail(error instanceof Error ? error.message : String(error));
});
