# MCDM Decision Maker

A browser-based Multi-Criteria Decision Making tool for two-team group decision support, built for IHE Delft Module 07: Decision Support Systems.

**Live app:** [https://decisionsupportplayground.github.io](https://decisionsupportplayground.github.io)

---

## What it does

Two teams independently rank criteria by importance and select preferred alternatives from a shared dataset. MCDM algorithms (TOPSIS, SAW, MABAC, ARAS) score and rank the alternatives for each team. A combined view shows where teams agree and where they differ.

Algorithms run in-browser via [pymcdm](https://github.com/kotbass/pymcdm) loaded into WebAssembly using [Pyodide](https://pyodide.org) — no server required.

---

## Getting started

Data is stored in a Google Sheet. See **[SETUP.md](SETUP.md)** for step-by-step instructions on creating the sheet, deploying the Apps Script backend, and connecting the app.

For offline use (no Google Sheet), click **Load CSV file** on the landing page.

---

## Development

Requires Node.js 18+.

```bash
# Serve the app locally
python3 -m http.server 8080

# Run tests
npm install
npm test
```

Tests validate TOPSIS, SAW, MABAC, and ARAS scores against reference outputs from the course dataset.
