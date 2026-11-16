# 农业气象采集台

农村气象站数据的跨源校准。本地演示版用于接收经过结构化的来源记录，保留来源、采集时间和属性，并提供可重启的本地查询。

## Requirements

- Node.js 20 or later; no network services or third-party packages are required.

## Run

`npm start -- ingest` imports the synthetic records in `fixtures/records.json`. Run `npm start -- query` to read the stored collection. Runtime state is written beneath `var/`.

## Tests

Run `npm test` to exercise normalization, duplicate handling, time filtering, and persistence across service restarts.
