const placeholder = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;

/** A small immutable builder for checked text templates imported with `type: "text"`. */
export class TextTemplate {
  readonly #source: string;
  readonly #values: Readonly<Record<string, string>>;

  private constructor(source: string, values: Readonly<Record<string, string>>) {
    this.#source = source;
    this.#values = values;
  }

  static from(source: string): TextTemplate {
    return new TextTemplate(source, {});
  }

  value(name: string, value: string | number | boolean): TextTemplate {
    return new TextTemplate(this.#source, { ...this.#values, [name]: String(value) });
  }

  values(values: Readonly<Record<string, string | number | boolean>>): TextTemplate {
    let template: TextTemplate = this;
    for (const [name, value] of Object.entries(values)) template = template.value(name, value);
    return template;
  }

  render(): string {
    const missing = new Set<string>();
    const rendered = this.#source.replace(placeholder, (_match, name: string) => {
      const value = this.#values[name];
      if (value === undefined) {
        missing.add(name);
        return "";
      }
      return value;
    });
    if (missing.size > 0) {
      throw new Error(`Missing template values: ${[...missing].sort().join(", ")}`);
    }
    return rendered;
  }
}
