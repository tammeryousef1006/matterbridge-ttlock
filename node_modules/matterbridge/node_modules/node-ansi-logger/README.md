# Node ansi logger and stringify

[![npm version](https://img.shields.io/npm/v/node-ansi-logger.svg)](https://www.npmjs.com/package/node-ansi-logger)
[![npm downloads](https://img.shields.io/npm/dt/node-ansi-logger.svg)](https://www.npmjs.com/package/node-ansi-logger)
![Node.js CI](https://github.com/Luligu/node-ansi-logger/actions/workflows/build.yml/badge.svg)

---

AnsiLogger is a lightweight, customizable color logger for Node.js.

## Features

- Simple and intuitive API for data logging.
- Customizable colors and apperance.
- It is also possible to pass a top level logger (like Homebridge or Matter logger) and AnsiLogger will use it
  for output instead of console.
- Includes also a fully customizable stringify funtions with colors.

## Getting Started

### Prerequisites

- Node.js installed on your machine.
- node-ansi-logger has no dependencies!

### Installation

To get started with AnsiLogger in your package

```bash
npm install node-ansi-logger
```

# Usage

## Initializing AnsiLogger:

Create an instance of AnsiLogger.

```
import { AnsiLogger, AnsiLoggerParams, LogLevel } from 'node-ansi-logger';
```

```
const log = new AnsiLogger({logName: '<your name>'}); // Eventually other params in AnsiLoggerParams
```

To import the stringify functions

```
import { stringify, payloadStringify, colorStringify, mqttStringify, debugStringify } from 'node-ansi-logger';
```

## Using the logger:

```
log.debug('Debug message...', ...parameters);
log.info('Info message...', ...parameters);
log.notice('Notice message...', ...parameters);
log.warn('Warning message', ...parameters);
log.error('Error message', ...parameters);
log.fatal('Fatal message', ...parameters);
log(LogLevel.WARN, 'Warning message', ...parameters)
```

## Using the logger with colors inside the message:

```
log.debug(`Debug message ${YELLOW}with yellow part${db}`, ...);
```

## Using the logger internal timer:

```
log.startTimer('Time sensitive code started')
log.stopTimer('Time sensitive code finished')
```

## Using the stringify function:

```
stringify({...})
colorStringify({...})
```

# Screenshot

![Example Image](https://github.com/Luligu/node-ansi-logger/blob/main/screenshot/Screenshot.png)

# Contributing

Contributions to AnsiLogger are welcome.

# License

This project is licensed under the MIT License - see the LICENSE file for details.
