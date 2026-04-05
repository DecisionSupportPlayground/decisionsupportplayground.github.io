# MADM Decision Maker — Setup Guide

Multi-Criteria Analysis for two-team group decision support.  
IHE Delft — Module 07: Decision Support Systems.

Live app: **[https://decisionsupportplayground.github.io](https://decisionsupportplayground.github.io)**

---

## Quick start (3 steps)

1. **Create a Google Sheet** and add the Apps Script backend
2. **Deploy** the script as a web app and copy the URL
3. **Open the app**, paste the URL, and launch

---

## Step 1 — Set up your Google Sheet

> **Each group needs their own sheet.** Anyone can create one on their own Google account — the sheet does not need to be on any particular account. The only requirement is that you have a Google account to create the sheet and deploy the script.

### 1a. Create the sheet

1. Go to [sheets.google.com](https://sheets.google.com) and create a new blank spreadsheet
2. Give it a recognisable name (e.g. "MADM Group 3")

### 1b. Add the script

1. In the spreadsheet, click **Extensions → Apps Script**  
   *(A new browser tab opens with the Apps Script code editor)*
2. Select all the default code in the editor (Ctrl+A / ⌘+A) and delete it
3. Download the script from the app's landing page ("Download Script").  
   The file is called `MADM_Code.txt` — open it in any text editor  
   (Notepad on Windows, TextEdit on Mac, or VS Code)
4. Select all the text, copy it, and paste it into the Apps Script editor
5. Save: Ctrl+S / ⌘+S — name the project anything you like

### 1c. Run the setup function

> **Important:** Saving the script does not automatically show a menu in your spreadsheet. You need to run the setup function directly from the Apps Script editor.

1. In the Apps Script editor, look for the function dropdown in the toolbar (it shows the function name). Make sure it shows **`initializeSheets`**. If it shows something else, click the dropdown and select `initializeSheets`.
2. Click the **▶ Run** button
3. A pop-up will ask you to authorize the script — click **Review permissions**, choose your Google account, click **Advanced → Go to [project name] (unsafe)**, then **Allow**  
   *(The "unsafe" warning is standard for self-deployed scripts — this is your own code on your own sheet)*
4. The script will create three tabs in your spreadsheet:
   - **Alternatives** — pre-filled with the course river basin example data
   - **Rankings** — stores each team's criteria ranking (managed by the app)
   - **Snapshots** — stores saved decision snapshots (managed by the app)

You can now close the Apps Script tab and go back to your spreadsheet.

---

## Step 2 — Deploy as a web app

The app communicates with your sheet through a deployed web app URL. You must deploy once to get this URL.

1. Open the Apps Script editor again: **Extensions → Apps Script**
2. Click **Deploy → New deployment**
3. Click the **gear icon ⚙** next to "Select type" and choose **Web app**
4. Fill in the settings:
   - **Description:** MADM Decision Maker *(or anything — this is just a label)*
   - **Execute as:** Me
   - **Who has access:** Anyone
5. Click **Deploy**
6. If prompted to authorize again, follow the same steps as in 1c above
7. Copy the **Web app URL** — it looks like:  
   `https://script.google.com/macros/s/AKfycbx.../exec`

> **Keep this URL.** It is how the app talks to your sheet. Share it with your group members.

> **Re-deploying:** If you later edit the script code, you must create a **New deployment** for the changes to take effect. The old URL keeps pointing to the old version until you update it.

---

## Step 3 — Launch the app

1. Open the app: [https://decisionsupportplayground.github.io](https://decisionsupportplayground.github.io)
2. Paste your Web app URL into the input field
3. Click **Launch**

Both teams can now open the same URL in their browsers and work simultaneously. Rankings update every 5 seconds automatically, or immediately with the **Refresh Now** button.

---

## Editing the alternatives data

The **Alternatives** tab in your sheet contains the decision matrix. You can edit it directly in Google Sheets.

**Column format:**

| ID  | Description     | Criterion 1 (the higher the better) | Criterion 2 (the higher the worst) | … |
|-----|-----------------|--------------------------------------|-------------------------------------|---|
| A1  | Situation as is | 0.6                                  | 2394.758                            | … |
| A2  | Option 1b       | 0.6                                  | 10739.871                           | … |

Rules:
- **Row 1** is the header. Columns 1–2 must be `ID` and `Description`. All other columns are criteria.
- Each criterion header **must** contain either `(the higher the better)` (benefit) or `(the higher the worst)` (cost). This sets the optimisation direction and is fixed — it is a property of the indicator, not a team preference.
- **Data rows** start with an alternative ID like `A1` or `A6.2`. Remaining columns are numeric values.
- Blank rows are skipped.

After editing, click **Refresh Now** in the app to reload the new data.

---

## Offline mode

You can use the tool without a Google Sheet. From the landing page, click **Load CSV file** and select your local alternatives file. Rankings are stored in the browser only and are not shared.

The CSV file must follow the same format as the Alternatives tab described above.

---

## Running the tests (developers)

Requires Node.js 18 or later.

```bash
npm test
```

No packages to install. Tests cover all four MCDM methods and the CSV parser.

---

## MCDM methods

| Method | Description |
|--------|-------------|
| **SAW** | Simple Additive Weighting. Min-max normalise, weight, sum. Score ∈ [0,1]. |
| **TOPSIS** | Technique for Order Preference by Similarity to Ideal Solution. Score = closeness to ideal best vs. ideal worst. Score ∈ [0,1]. |
| **MABAC** | Multi-Attributive Border Approximation area Comparison. Score = sum of distances from the geometric-mean border. Positive = above average. |
| **ARAS** | Additive Ratio Assessment. Score = ratio relative to a hypothetical optimal alternative. Score ∈ [0,1]. |

### Weight exponent (p)

```
w_i = (n − rank_i + 1)^p  /  Σ_j (n − rank_j + 1)^p
```

| p | Effect |
|---|--------|
| 0 | Equal weights — rank order is ignored |
| 0.5 | Moderate — top-ranked criteria get somewhat more weight |
| 1 | Linear — weight decays linearly from rank 1 to rank n |

---

## Security notice

> The deployed Apps Script is a **publicly accessible web service**. Anyone with the URL can read and write your spreadsheet. Do not store sensitive, personal, or confidential information. This tool is for academic exercises only.
>
> If the URL is accidentally shared, create a **New deployment** from the Apps Script editor — the new URL replaces the old one, which immediately stops working.
