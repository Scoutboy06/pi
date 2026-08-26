export type OutputStyleSource = "builtin" | "user" | "project";

export interface OutputStyle {
  name: string;
  description: string;
  keepCodingInstructions: boolean;
  instructions: string;
  source: OutputStyleSource;
  filePath?: string;
}

export interface OutputStyleDiagnostic {
  path: string;
  message: string;
}

export function normalizeStyleName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

export class OutputStyleRegistry {
  private stylesByName = new Map<string, OutputStyle>();
  private activeStyle: OutputStyle;

  constructor(styles: OutputStyle[]) {
    this.replace(styles);
    this.activeStyle = this.requireDefault();
  }

  list(): OutputStyle[] {
    const sourceOrder: Record<OutputStyleSource, number> = {
      builtin: 0,
      user: 1,
      project: 2,
    };

    return [...this.stylesByName.values()].sort(
      (left, right) =>
        sourceOrder[left.source] - sourceOrder[right.source] || left.name.localeCompare(right.name),
    );
  }

  replace(styles: OutputStyle[]): void {
    const activeName = this.activeStyle?.name;
    this.stylesByName = new Map(styles.map((style) => [normalizeStyleName(style.name), style]));

    if (activeName) {
      this.activeStyle = this.resolve(activeName) ?? this.requireDefault();
    }
  }

  resolve(name: string): OutputStyle | undefined {
    return this.stylesByName.get(normalizeStyleName(name));
  }

  activate(name: string): OutputStyle | undefined {
    const style = this.resolve(name);
    if (style) this.activeStyle = style;
    return style;
  }

  getActive(): OutputStyle {
    return this.activeStyle;
  }

  buildSystemPrompt(basePrompt: string, cwd: string, preservedContext = ""): string {
    const style = this.activeStyle;
    if (style.source === "builtin" && normalizeStyleName(style.name) === "default") {
      return basePrompt;
    }

    const styleBlock = `<output_style name=${JSON.stringify(style.name)}>
Follow these output-style instructions throughout your response. They change how you respond, not what you know.

${style.instructions}
</output_style>`;

    if (style.keepCodingInstructions) {
      return `${basePrompt}\n\n${styleBlock}`;
    }

    return `You are an AI assistant accessed through Pi.
Current working directory: ${cwd}
Use the tools provided to you when they help complete the user's request.

${styleBlock}${preservedContext}`;
  }

  private requireDefault(): OutputStyle {
    const defaultStyle = this.resolve("default");
    if (!defaultStyle) throw new Error('Output styles must include a "Default" style');
    return defaultStyle;
  }
}
