import { Container, type Focusable, getKeybindings, Input, Text } from "@earendil-works/pi-tui";
import type {
	QuestionnaireAnswerValue,
	QuestionnaireForm,
	QuestionnaireOutcome,
} from "../../../core/tools/questionnaire.js";
import { theme } from "../theme/theme.js";
import { keyHint } from "./keybinding-hints.js";
import { getMenuListLayout, MenuList, MenuPanel, MenuRow } from "./menu-panel.js";

export class QuestionnaireComponent extends Container implements Focusable {
	private tab: number;
	private selected = 0;
	private readonly answers: Map<string, QuestionnaireAnswerValue>;
	private input: Input | undefined;
	private finished = false;
	private _focused = false;
	private readonly onAbort = () => this.finish("cancelled");

	constructor(
		private readonly form: QuestionnaireForm,
		private readonly done: (outcome: QuestionnaireOutcome) => void,
		private readonly options: { signal?: AbortSignal; getRows?: () => number } = {},
	) {
		super();
		this.answers = new Map(Object.entries(form.answers));
		const firstUnanswered = form.questions.findIndex((question) => !this.answers.has(question.id));
		this.tab = firstUnanswered < 0 ? form.questions.length : firstUnanswered;
		this.restoreSelection();
		options.signal?.addEventListener("abort", this.onAbort, { once: true });
		this.update();
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		if (this.input) this.input.focused = value;
	}

	override render(width: number): string[] {
		if (this.options.signal?.aborted) this.onAbort();
		this.update();
		return super.render(width);
	}

	handleInput(data: string): void {
		if (this.finished) return;
		const kb = getKeybindings();
		if (this.input) {
			if (kb.matches(data, "tui.select.cancel")) this.input = undefined;
			else if (kb.matches(data, "tui.select.confirm")) {
				const question = this.form.questions[this.tab];
				const value = this.input.getValue().trim() || "(no response)";
				this.answers.set(question.id, { value, wasCustom: true });
				this.input = undefined;
				this.advance();
			} else this.input.handleInput(data);
		} else if (kb.matches(data, "tui.select.cancel")) this.finish("cancelled");
		else if (kb.matches(data, "tui.input.tab") || kb.matches(data, "tui.editor.cursorRight")) this.moveTab(1);
		else if (kb.matches(data, "tui.editor.cursorLeft")) this.moveTab(-1);
		else if (kb.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
		else if (kb.matches(data, "tui.select.down")) {
			const question = this.form.questions[this.tab];
			if (question)
				this.selected = Math.min(question.options.length - (question.allowOther ? 0 : 1), this.selected + 1);
		} else if (kb.matches(data, "tui.select.confirm")) this.confirm();
		this.update();
	}

	private confirm(): void {
		const { questions } = this.form;
		const question = questions[this.tab];
		if (!question) {
			if (this.tab === questions.length + 1) this.finish("deferred");
			else if (questions.every((question) => this.answers.has(question.id))) this.finish("submitted");
			return;
		}
		const option = question.options[this.selected];
		if (option) {
			this.answers.set(question.id, { value: option.value, wasCustom: false });
			this.advance();
		} else if (question.allowOther) {
			this.input = new Input();
			const saved = this.answers.get(question.id);
			if (saved?.wasCustom) this.input.setValue(saved.value);
			this.input.focused = this.focused;
		}
	}

	private advance(): void {
		const next = this.form.questions.findIndex(
			(question, index) => index > this.tab && !this.answers.has(question.id),
		);
		this.tab = next < 0 ? this.form.questions.length : next;
		this.restoreSelection();
	}

	private moveTab(direction: number): void {
		const count = this.form.questions.length + 2;
		this.tab = (this.tab + direction + count) % count;
		this.restoreSelection();
	}

	private restoreSelection(): void {
		const question = this.form.questions[this.tab];
		const saved = question && this.answers.get(question.id);
		this.selected =
			!question || !saved
				? 0
				: saved.wasCustom
					? question.options.length
					: Math.max(
							0,
							question.options.findIndex((option) => option.value === saved.value),
						);
	}

	private finish(status: QuestionnaireOutcome["status"]): void {
		if (this.finished) return;
		this.finished = true;
		this.dispose();
		this.done({ status, answers: Object.fromEntries(this.answers) });
	}

	private update(): void {
		this.clear();
		const { questions } = this.form;
		const tabs = [
			...questions.map((question) => `${this.answers.has(question.id) ? "■" : "□"} ${question.label}`),
			"Submit",
			"Defer",
		];
		const title = tabs
			.map((label, index) => (index === this.tab ? theme.fg("accent", `[${label}]`) : label))
			.join("  ");
		const question = questions[this.tab];
		const panel = new MenuPanel({ title, subtitle: question?.prompt, inline: true });
		this.addChild(panel);
		if (question) {
			const list = new MenuList({ compact: true, inline: true });
			panel.addChild(list);
			const options = [
				...question.options.map((option) => ({
					label: `${option.label}${option.recommended ? " — Recommended" : ""}`,
					description: option.description,
				})),
				...(question.allowOther ? [{ label: "Type something.", description: undefined }] : []),
			];
			const layout = getMenuListLayout({
				getRows: this.options.getRows,
				totalItems: options.length,
				preferredVisibleItems: 8,
				reservedRows: 7,
				comfortableItemRows: 2,
				compactItemRows: 2,
				scrollIndicatorRows: 1,
			});
			const start = Math.max(
				0,
				Math.min(this.selected - Math.floor(layout.visibleItems / 2), options.length - layout.visibleItems),
			);
			for (let index = start; index < Math.min(options.length, start + layout.visibleItems); index++) {
				list.addChild(
					new MenuRow({
						primary: `${index + 1}. ${options[index].label}`,
						secondary: options[index].description,
						selected: index === this.selected,
						inline: true,
					}),
				);
			}
			if (options.length > layout.visibleItems)
				panel.addChild(new Text(`${this.selected + 1}/${options.length}`, 0, 0));
			if (this.input) panel.addChild(this.input);
		} else if (this.tab === questions.length + 1) {
			panel.addChild(
				new Text(
					"Save completed answers and show the questions in chat without submitting. Unconfirmed text is not saved. Reopen only when you ask.",
					0,
					0,
				),
			);
		} else {
			for (const question of questions) {
				const answer = this.answers.get(question.id);
				const option = answer && question.options.find((option) => option.value === answer.value);
				const label = !answer ? "Unanswered" : answer.wasCustom ? answer.value : (option?.label ?? answer.value);
				panel.addChild(new Text(`${question.label}: ${label}`, 0, 0));
			}
		}
		panel.addChild(
			new Text(
				this.input
					? `${keyHint("tui.select.confirm", "save")}  ${keyHint("tui.select.cancel", "back")}`
					: `${keyHint("tui.input.tab", "next tab")}  ${keyHint("tui.editor.cursorLeft", "previous tab")}  ${keyHint("tui.select.up", "up")}  ${keyHint("tui.select.down", "down")}  ${keyHint("tui.select.confirm", "confirm")}  ${keyHint("tui.select.cancel", "cancel")}`,
				0,
				0,
			),
		);
	}

	dispose(): void {
		this.options.signal?.removeEventListener("abort", this.onAbort);
	}
}
