# Code.md - pi/extensions

This document outlines the code guidelines and best practices for developing extensions in the pi ecosystem. It covers topics such as code structure, naming conventions, testing, and documentation.

All pi extensions are written in TypeScript, and tested using Bun test.

## Code Structure

When developing extensions, it is important to maintain a clear and organized code structure. Follow these guidelines:

- Plan your extension's architecture in terms of modules, classes, and functions, before writing any code.
- Use a consistent directory structure for your extension. A common structure is:

```
my-extension/
├── src/
│   ├── index.ts
│   ├── module1.ts
│   └── module2.ts
├── tests/
│   ├── module1.test.ts
│   └── module2.test.ts
├── CODE.md
└── README.md
```

## Code Guidelines

### OOP

We prefer to use OOP principles when planning and implementing extensions. This means:

- Use classes to encapsulate related functionality and data.
- Use interfaces over concrete types when defining contracts for your classes. This promotes flexibility and allows for easier testing and mocking.
- Use dependency injection to manage dependencies between classes. This makes your code more modular and easier to test.
- Use composition over inheritance when possible. This allows for more flexible and reusable code.
- Use design patterns where appropriate, such as the Factory pattern for creating instances of classes, or the Observer pattern for event-driven programming.

### Naming Conventions

- When naming a class, the naming is always a singular noun, while functions and methods are always verbs.

### Testing

We use Bun test for testing our extensions. Follow these guidelines:

- Use dependency injection to make your classes easier to test.
- Write unit tests for classes and functions that have complex logic or behavior.
- Use mocks and stubs to isolate the code being tested from external dependencies.
- Write integration tests for classes and functions that interact with external systems or APIs.
- The goal of testing is to mock a complete environment for the extension, all the way from the extension's entry point to the external systems it interacts with. This ensures that your extension behaves correctly in a real-world scenario.

### TypeScript

#### using `as`

When using `as` in TypeScript, you should always:

1. prefer doing it another way. For example:
  - `return foo as Bar` -> `): Bar {`
  - `const bar = foo as Bar` -> `const bar: Bar = foo`
2. If you must use `as`, ensure that the type assertion is safe and that it does not lead to any unexpected behavior. If you are unsure, consider using a type guard or a type predicate before assering it.
