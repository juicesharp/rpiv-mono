/**
 * Session-owned input-buffer cell. Replaces the imperative input-buffer
 * methods that previously lived on `OptionListView` (`view`-layer ownership
 * was a Liskov violation — a view owning interactive state others read).
 *
 * The cell is mutable by design. The reducer does NOT know about the buffer
 * (D3's per-keystroke perf invariant); only the runtime side mutates it via
 * effect handlers (`set_input_buffer`, `clear_input_buffer`) and the
 * inline-key side-band (`handleIgnoreInline` for printable keys + backspace).
 *
 * The value flows to the view via `runtime.inputBuffer` → `selectOptionListProps`
 * → `OptionListView.setProps({inputBuffer})` per tick.
 */
export class InputBuffer {
	private value = "";

	get(): string {
		return this.value;
	}

	set(value: string): void {
		this.value = value;
	}

	clear(): void {
		this.value = "";
	}

	append(chunk: string): void {
		this.value = this.value + chunk;
	}

	backspace(): void {
		if (this.value.length === 0) return;
		this.value = this.value.slice(0, -1);
	}
}
