# Reference: FJC Integrated Database — Civil Codebook (1988 forward)

Reference for Phase 11 part 3 (case value). Chosen by Tracy, 13 November 2026: build on the free federal data, with medians only, case counts shown, ranges refused when too few cases, labelled "federal judgments, not settlements", suspect values excluded, and the "not a prediction" wording kept.

| | |
|---|---|
| Publisher | Federal Judicial Center (FJC), Integrated Data Base (IDB), civil cases filed, terminated and pending, SY 1988 to present |
| Official page | https://www.fjc.gov/node/13146 (overview: https://www.fjc.gov/research/idb) |
| Official codebook link | https://www.fjc.gov/sites/default/files/idb/codebooks/Civil%20Codebook%201988%20Forward%2010252023.pdf |
| Data file (tab-delimited, cumulative) | https://www.fjc.gov/sites/default/files/idb/textfiles/cv88on.zip (terminations through 30 June 2026 at the time of writing; FJC receives data quarterly) |
| Copy in this repo | `docs/source/fjc-civil-codebook-1988-forward-2023-10-25.pdf` (SHA-256 `57c1ab722420e3e680fabf02865fca3d49b3939261f380c04ba7873979c81adf`). Huis's build workspace can't reach fjc.gov, so this copy came from a public GitHub repository (Ananthvarshan/fjc-civil-cases-ml) under the official file name. **Check it against the official link before relying on it.** |

## Fields Huis would use (quoted from the codebook)

| Field | Codebook text |
|---|---|
| `DISTRICT` | District court in which the case was filed. Utah is `88`. |
| `NOS` | "A 3 digit statistical code representing the nature of the action filed." Codes Huis maps claims to (checked against the uscourts.gov NOS list): 190 Other Contract; 360 Other Personal Injury; 442 Civil Rights – Employment; 445 Americans With Disabilities – Employment; 710 Fair Labor Standards Act (Non-Union); 751 Family and Medical Leave Act; 791 ERISA |
| `FILEDATE` / `TERMDATE` | The date the case was filed; the date the district court received the final judgment or the order disposing of the case |
| `DISP` | Manner of disposition. Dismissals: 2 want of prosecution, 3 lack of jurisdiction, 12 voluntarily, **13 settled**, 14 other. Judgment on: 4 default, 5 consent, 6 motion before trial, **7 jury verdict**, 8 directed verdict, **9 court trial**, 15 arbitrator, 16 stayed pending bankruptcy, 17 other, 18 statistical closing. Transfers/remands: 0, 1, 10, 11. −8 missing |
| `JUDGMENT` | Final judgment in favor of: 1 plaintiff, 2 defendant, 3 both, 4 unknown; 0/−8 missing |
| `NOJ` | Nature of judgment: 0 no monetary award, 1 monetary award only, 2 monetary award and other, 3 injunction, 4 forfeiture etc., 5 costs only, 6 costs and attorney fees |
| `AMTREC` | "Dollar amount received (in thousands) when appropriate. **This variable is not used uniformly by the 94 district courts. The Statistics Division advises against the use for this data for analysis purposes because it is not a mandatory data field.** (Some courts may be using '9999' to indicate amounts over $1 million while others may be using it as a filler or for an unknown amount.)" |
| `DEMANDED` | "The monetary amount sought by plaintiff (in thousands)." Amounts under $500 appear as 1; the cap is 9999; "In the past, courts have not always reported this field in thousands of dollars, therefore data may not be accurate." |

## What this means for part 3

- **Settlement amounts are not in the data.** `DISP = 13` says a case settled, not for how much.
- **The dollar field (`AMTREC`) is one the FJC itself advises against analysing.** Independent research agrees it overstates averages; medians are closer once suspect values are removed (Eisenberg & Schlanger, "The Reliability of the Administrative Office of the U.S. Courts Database", Notre Dame Law Review, 2003: https://scholarship.law.cornell.edu/lsrp_papers/28). That study covered tort and prisoner civil rights cases only.
- **Reliable fields** for benchmarks: how cases of this type ended in this district (settled, dismissed, judgment for which side, trial rate) and time to disposition (`TERMDATE − FILEDATE`).
