import { runInNewContext } from "node:vm";
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");
const markedJs = readFileSync(new URL("../src/core/export-html/vendor/marked.min.js", import.meta.url), "utf-8");

function renderMarkdown(markdown: string): string {
	const helpers = templateJs.slice(
		templateJs.indexOf("function escapeHtml("),
		templateJs.indexOf("function truncate("),
	);
	const setup = templateJs.slice(
		templateJs.indexOf("const strictStrikethroughRegex"),
		templateJs.indexOf("function safeMarkedParse("),
	);
	return runInNewContext(`${markedJs}\n${helpers}\n${setup}\nmarked.parseInline(markdown)`, {
		markdown,
		document: {
			createElement: () => ({
				textContent: "",
				get innerHTML() {
					return this.textContent.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
				},
			}),
		},
	});
}

describe("export HTML markdown link sanitization", () => {
	it.each([
		["http://example.com/p?a=1&b=2", "http://example.com/p?a=1&amp;b=2"],
		["https://example.com/p", "https://example.com/p"],
		["mailto:person@example.com", "mailto:person@example.com"],
		["tel:+15551234567", "tel:+15551234567"],
		["ftp://example.com/p", "ftp://example.com/p"],
		["../p?a=1&b=2", "../p?a=1&amp;b=2"],
		["HTTPS://example.com/p", "HTTPS://example.com/p"],
		["", ""],
		["https://exa\x01mple.com/p\x7fath", "https://example.com/path"],
	])("renders allowed link and image URLs: %j (pi 6cb23f9b5)", (href, escapedHref) => {
		const html = renderMarkdown(`[**label**](<${href}> "title & <tag>") ![<alt>&](<${href}> "title & <tag>")`);
		expect(html).toBe(
			`<a href="${escapedHref}" title="title &amp; &lt;tag&gt;"><strong>label</strong></a> <img src="${escapedHref}" alt="&lt;alt&gt;&amp;" title="title &amp; &lt;tag&gt;">`,
		);
	});

	it.each([
		"javascript:alert(1)",
		"vbscript:msgbox(1)",
		"data:text/html,<script>",
		"java\tscript:alert(1)",
		"\x01 javascript:alert(1)",
		"custom+app:x",
	])("renders only labels for rejected URLs: %j (pi 6cb23f9b5)", (href) => {
		const html = renderMarkdown(`[**label**](<${href}>) ![<alt>&](<${href}>)`);
		expect(html).toBe("<strong>label</strong> &lt;alt&gt;&amp;");
	});

	it("escapes quotes in rendered URL attributes (pi 6cb23f9b5)", () => {
		const html = renderMarkdown(
			`[x](<https://a.example/'" onmouseover="alert(1)>) ![x](<https://a.example/'" onerror="alert(1)>)`,
		);
		expect(html).toBe(
			'<a href="https://a.example/&#39;&quot; onmouseover=&quot;alert(1)">x</a> <img src="https://a.example/&#39;&quot; onerror=&quot;alert(1)" alt="x">',
		);
	});

	it("escapes href attributes in the custom link renderer", () => {
		expect(templateJs).toMatch(/escapeHtml\(href\)/);
	});

	it("escapes image mimeType attributes", () => {
		expect(templateJs).not.toMatch(/\$\{img\.mimeType\}/);
		expect(templateJs).toMatch(/escapeHtml\(img\.mimeType/);
	});

	it("escapes image data attributes", () => {
		expect(templateJs).not.toMatch(/;base64,\$\{img\.data\}"/);
		expect(templateJs).toMatch(/;base64,\$\{escapeHtml\(img\.data \|\| (?:''|"")\)\}"/);
	});

	it("escapes entry IDs before inserting them into attributes", () => {
		expect(templateJs).not.toMatch(/id="\$\{entryId\}"/);
		expect(templateJs).not.toMatch(/data-entry-id="\$\{entryId\}"/);
		expect(templateJs).toMatch(/entry-\$\{escapeHtml\(entry\.id\)\}/);
		expect(templateJs).toMatch(/data-entry-id="\$\{escapeHtml\(entryId\)\}"/);
	});

	it("escapes tree metadata rendered from session fields", () => {
		expect(templateJs).not.toMatch(/\[\$\{msg\.toolName \|\| 'tool'\}\]/);
		expect(templateJs).not.toMatch(/\[\$\{msg\.role\}\]/);
		expect(templateJs).not.toMatch(/\[model: \$\{entry\.modelId\}\]/);
		expect(templateJs).not.toMatch(/\[thinking: \$\{entry\.thinkingLevel\}\]/);
		expect(templateJs).not.toMatch(/\[service tier: \$\{entry\.serviceTier\}\]/);
		expect(templateJs).not.toMatch(/\[\$\{entry\.type\}\]/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(msg\.toolName \|\| 'tool'\)\}/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(msg\.role\)\}/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(entry\.modelId\)\}/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(entry\.thinkingLevel\)\}/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(entry\.serviceTier \|\| 'default'\)\}/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(entry\.type\)\}/);
	});

	it("escapes model names in the exported header", () => {
		expect(templateJs).not.toMatch(/\$\{globalStats\.models\.join\(', '\) \|\| 'unknown'\}/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(globalStats\.models\.join\(', '\) \|\| 'unknown'\)\}/);
	});
});
