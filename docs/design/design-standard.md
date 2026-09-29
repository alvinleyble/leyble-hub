# Leyble Hub design standard

The rules every screen follows, so the same job looks and works the same way everywhere.
They came out of the 2026-09-28 UI audit (phone and tablet screenshots of every screen,
ranked findings F1–F23). The captain answered the audit's design questions on 2026-09-28:
every recommendation was adopted except Q12, where the captain chose icons only. After
reviewing the before/after screenshots on 2026-09-29, the captain reversed Q1 and set
each list's phone look (the "round-8" decisions, R1–R5 below).

Each rule lives in code, not in copies. When a screen needs one of these patterns, use the
shared piece named under the rule. Do not restyle it locally.

| Rule | Shared code |
|---|---|
| Page frame and spacing (Q11) | `client/src/components/ui/Page.jsx` |
| Page header row, extra actions (Q2, Q9) | `client/src/components/ui/PageHeader.jsx` |
| Search and filters (Q3) | `client/src/components/ui/SearchFilterBar.jsx` |
| Chip rows (Q4) | `client/src/components/ui/ChipRow.jsx` |
| Status and stock badges (Q5) | `client/src/utils/statusBadges.js`, `client/src/components/ui/Badge.jsx` |
| Phone and upright-tablet list card (Q6, R2–R4) | `client/src/components/ui/ListCard.jsx` |
| Icons (Q10) | `client/src/components/layout/NavIcon.jsx` |
| Read-first detail panels (Q13) | `client/src/components/ui/DetailList.jsx` |
| Main buttons, 48px targets (Q8, Q14) | `client/src/components/ui/Button.jsx` |
| Money (Q15) | `client/src/utils/money.js` |
| Going back | `client/src/components/ui/BackLink.jsx` |

---

## Q1. Where phone layout ends and tablet layout begins

**Decision (revised by the captain, 2026-09-29):** phones and upright tablets share **one
card layout**. Lists become tables only at **1024px** and up (Tailwind `lg:`), which means
a tablet held sideways. A Pixel Tablet held upright (800px) shows the same cards and the
same one-column New Order as a phone. When a page keeps its previous look (R2), it keeps
it on phones and upright tablets alike.

Headers, search + Filters, chip rows and page spacing are not part of this switch: they
look the same at every width, and the page edge still widens to 24px from 768px (Q11).

**Considered:**
- *Switch at 768px, so an upright tablet gets tables (the 2026-09-28 pick):* built and
  screenshotted, but on review the captain preferred the phone look on an upright tablet.
  Most of the review notes were about upright-tablet tables.
- *Old cards on an upright tablet, new cards on phones:* two designs per page that would
  drift apart.
The audit's complaint about stretched cards on an upright tablet (F15) is accepted as the
cost of this choice.

## Q2. The top of every page

**Decision:** one row at every size. The title is on the left and the page's one main button
is on the right (`PageHeader`). The title may wrap to two lines on a narrow phone, but the
button never moves to its own row.

**Considered:**
- *Phone: title row, then a full-width button below:* a big obvious button, but it cost a
  whole row on every page (audit F2, F12).
- *Phone: a floating round "+" button:* frees the header, but hides what the button does and
  can cover the last card.

## Q3. Search and filters

**Decision:** the search box gets its own full-width row. One **Filters** button beside it
opens a panel holding everything else: dates, show inactive, receipt printed, product,
action, type. While any filter is on, the button shows how many ("Filters 2"), and each
active filter shows under the search as a chip with its own ✕. **Clear all** appears when
two or more are on. A screen with nothing to search (Audit Log) shows the Filters button
alone.

**Considered:**
- *Everything inline and wrapping:* visible at a glance, but at 360px it filled the whole
  first screen before a single order (audit F2, F22).
- *Search only, filters in the ⋮ menu:* the tidiest, but an active filter becomes invisible
  ("where did my orders go?").

## Q4. Chip rows (status tabs, categories, filters)

**Decision:** one row that scrolls sideways and **never wraps**, at every size. When chips sit
past an edge, that edge fades out, which is the hint that the row scrolls. Every chip is
the same: a pill, 48px tall, 16px text, blue when selected. Amber or red is used only for
a chip whose whole meaning is attention: *Possible Duplicates*, *Low stock*, *Out of
stock*. The Outgoing status tabs, Inventory categories, the stock filter, the Tickets tabs
and Audit's Inventory/Activity switch all use this chip.

**Considered:**
- *Wrap onto more rows:* everything visible, but at 360px Outgoing's status tabs took three
  rows (audit F2).
- *A dropdown on phones:* the smallest, but the current choice is hidden and it takes two
  taps.

## Q5. Status and stock badges — what each colour means

**Decision:** one colour and one word per status, everywhere, and **always with the word**:

| Badge | Colour |
|---|---|
| Draft | violet |
| Pending (order or ticket) | blue |
| In Transit | amber |
| Delivered | green |
| Closed | grey |
| Cancelled | red |
| Resolved (ticket) | green |
| Low stock (at or below 10) | amber |
| Out of stock | red |
| Inactive | grey |
| Active (Customers, Personnel rows) | green |
| Waiting to sync, Possible duplicate, Not Printed | amber |
| Printed, Delivery | grey |
| Pickup | blue |

The words are **Delivered** and **Closed**, never "Completed" and "Done". Amber means "look
at this". A stock level is never shown by a red or amber number alone.

**Considered:**
- *The Dashboard's colours everywhere (Pending yellow, In Transit blue):* Pending-as-yellow
  reads as "waiting", but it meant changing four screens instead of one, and the two maps
  had been contradicting each other (audit F3).
- *A new palette:* the most change and relearning.

## Q6. What a phone list card shows

**Decision:** one component, `ListCard`, for every phone and upright-tablet list. Its
default recipe is:
1. **Line 1:** what it is (a customer, product, supplier or ticket name), with the money or
   key number on the right. The name wraps onto as many lines as it needs and is **never
   cut short**.
2. **Line 2:** the one most useful detail (receipt number, SKU, phone), with a secondary
   fact on the right (Sold by, In stock, Logged by).
3. **Line 3:** badges, **only when there is something to say**, plus any per-row action.

The whole card is the tap target. An ordinary state gets no badge, unless R2/R4 below say
otherwise for that page. `ListCard`'s `aside` gives the compact one-badge-on-the-right
row that Personnel keeps.

**Considered:**
- *Each screen designs its own card:* that produced five different cards (audit F21).
- *Tables on phones with sideways scroll:* the same as tablet, but slow, and it hides the
  money column.

### R2. Which pages use the new card, and which keep their previous look (round-8 grill)

**Decision:** on phones and upright tablets:

| Page | List look |
|---|---|
| Outgoing | New card, laid out as in R3 |
| Inventory | New card. It already matches the previous look, plus the requested "₱1,099.00 / case" |
| Customers | Previous two-line row, as in R4 |
| Personnel | Previous row: name, mobile (— when blank), one status badge on the right (Waiting to sync, Active or Inactive) |
| Tickets | Previous card: #number over the title, one line of description, amount on the right, status badge |
| Audit Log | Previous cards: what changed and when, the change or action on the right, badge or summary below |
| New Order | Previous one-column page with the cart sheet |
| Dashboard, Incoming | New card (not raised in the review) |

The new header, search + Filters and chip rows stay on every page; the captain approved
everything except the list/table part. The pages that keep their previous look are
rebuilt from the shared pieces (`ListCard`, `Badge`/`statusBadges.js`, `money.js`), so
status colours, money and spacing stay the same everywhere.

**Considered:**
- *The previous look everywhere, Outgoing included:* the captain had approved the new
  Outgoing card at 412px apart from where the date sat.

### R3. The Outgoing card

**Decision:** left column: customer name, the receipt number under it, then the status
badges. Right column: the total, "Sold by: Name", then the date and time under Sold by.

**Considered:**
- *Date and time on their own full-width bottom line:* one more line on every card.

### R4. The Customers row

**Decision:** on phones and upright tablets:
- **Line 1:** the name, with the customer type (e.g. Wholesaler) on the right.
- **Line 2:** mobile · address, with an em dash (—) for each one that is blank. An
  **Active** or **Inactive** badge sits on the right of **every** row.

On a sideways tablet, the table stays, and it shows an em dash in a blank mobile or
address cell.

**Considered:**
- *A badge on Inactive rows only (Q6's default):* less clutter, but the captain asked for
  Active/Inactive on every row.

### R5. Print status on Outgoing

**Decision:** the Print Status filter (All / Printed / Not Printed) lives in the
**Filters** panel at every size, never in a column header. On a sideways tablet, Outgoing
has its own **Print Status** column that reads "Printed" or "Not Printed" (a draft shows
—). The Date column shows the date and the time. The Customer column is narrower to
make room.

**Considered:**
- *A dropdown in the column header:* tablet only. Phones would still need Filters, so the
  same filter would live in two places.

## Q7. Smallest text and lightest grey

**Decision:** **16px** for anything you read to make a decision (names, amounts, buttons,
inputs). **14px** is the floor for secondary details (dates, "Sold by", SKU, labels).
Nothing smaller. No grey lighter than **slate-500** for text on a light background
(4.76:1 on white). slate-400 measured 2.56:1 and is no longer used for text.

**Considered:**
- *A strict 16px for everything (the old written rule):* the easiest to read, but cards get
  taller and fewer fit.
- *Keep 12px details:* the most compact, but hard to read for the owners, and it broke the
  written rule (audit F8).

## Q8. Tap targets

**Decision:** everything tappable is at least **48px tall**: buttons (including `size="sm"`),
chips, inputs, date boxes, checkbox tap areas and menu items. A text link that goes
somewhere becomes a button or a whole-row tap (for example, the Dashboard's receipt links,
"View all" and "← Orders").

**Considered:**
- *A 44px floor:* a little more compact, but a second number beside the 48px already in
  CLAUDE.md.
- *48px for main buttons only:* compact, but misses were frequent (audit F9).

## Q9. Where extra actions go

**Decision:** a page's extra actions (Print List, Batch Edit Prices) sit at the far right of
the header:
- **One** extra action is a plain secondary button (icon only on phones, with its word from
  768px).
- **Two or more** go in a ⋮ menu on phones and upright tablets, and become ordinary buttons
  on a landscape tablet (1024px and up), where there is room.

A one-item ⋮ menu is not allowed.

**Considered:**
- *⋮ on phones, buttons on tablets, ⋮ on the left:* the old pattern; the same action lived
  in two places, and Customers had a menu with one item (audit F12).
- *Everything in ⋮ on all sizes:* the tidiest, but the tablet loses one-tap Print.

## Q10. Icons

**Decision:** one set of drawn (SVG) icons, `NavIcon`, for buttons, badges and banners.
**No emoji as icons.** The 🖶 printer rendered as a "≣" list glyph (audit F10). Emoji may
still appear inside free text that people type.

**Considered:**
- *Emoji allowed:* quick to add, but it renders differently on each device and was already
  broken for the printer.

## Q11. Spacing

**Decision:**
- **Phone:** a 16px page edge, 12px between controls, 16px between sections.
- **Tablet (768px and up):** a 24px page edge and 24px between sections.

`Page` provides the frame and `SECTION_GAP` the section spacing.

**Considered:**
- *24px everywhere (the old `p-6`):* roomy on tablets, but it pushed the Inactive switch off
  a 360px screen (audit F6).

## Q12. Phone tab bar

**Decision (captain's pick):** the phone tab bar stays **icons only**. Each tab still names
itself to a screen reader, and tablets (640px and up) show the words.

**Considered:**
- *An icon with a short word under it:* this was the audit's recommendation. It was
  declined by the captain.
- *Four tabs plus "More" on phones:* room for bigger labels, but Incoming and Personnel sit
  a tap deeper.

## Q13. Tapping a record: see it first, or edit straight away

**Decision:** **read first.** A detail panel (Product, Customer, Personnel, Delivery) opens
as a read-only summary (`DetailList`) with an **Edit details** button. The form, with
Cancel and Save Changes, appears only after that tap, and Cancel puts back what the record
holds. The same rule covers an order's adjustment: a saved adjustment shows as a line with
an **Edit** button, never as an open form that looks unsaved (audit F16, F17).

**Considered:**
- *Straight into the edit form:* the fastest edit, but it is easy to change something by
  accident, and the key facts sat below the form.

## Q14. The colour of the main "do it" button

**Decision:** **blue** for every main action, including Create Order. **Red** only for
delete and cancel.

**Considered:**
- *Green for sale/money actions (the old Create Order):* adds meaning, but it is a second
  rule to keep consistent.

## Q15. How money is written

**Decision:** always `₱1,234.50`. A negative is `−₱135.00`: the minus sign (U+2212) comes
**before** the peso sign, never `₱-135.00`. A plus sign appears only where a list mixes
credits and debits (`+₱120.00`). An amount never splits across lines. On screen, money
goes through `formatPeso` / `formatSignedPeso` in `client/src/utils/money.js`. Printed
receipts keep their own formatting in `receiptTemplate.js` / `escposReceipt.js`.

**Considered:**
- None. This is how most screens already wrote money; the rule makes the exceptions
  (Tickets, audit F19) match.

## Q16. The screenshot check every UI change ships with

**Decision:** every change to what a screen looks like ships with screenshots at **all four
sizes**, checked against this standard before review:

| Size | Stands for |
|---|---|
| 360×740 | narrow phone |
| 412×915 | normal phone |
| 800×1280 | tablet held upright (phone layout) |
| 1280×800 | tablet held sideways (tables) |

**Considered:**
- *412 phone + 1280 tablet only:* fewer images, but it would have missed the 360px problems
  (audit F1, F6) and the upright-tablet one (F15).

### Checklist (run it on each of the four screenshots)

- [ ] No sideways page scroll, and nothing clipped at the right edge (money especially).
- [ ] Header: title and main button on one row; extras follow Q9.
- [ ] Search is full width; everything else is in Filters; active filters show as chips.
- [ ] Chip rows scroll on one line; nothing wraps.
- [ ] Every status or stock state has a word, in the Q5 colour.
- [ ] Below 1024px lists are cards (Q1), each page in its R2 look; names are not cut short.
- [ ] No text under 14px; no text lighter than slate-500.
- [ ] Every tappable thing is at least 48px tall.
- [ ] Icons come from `NavIcon`; no emoji used as an icon.
- [ ] Money follows Q15.
- [ ] Main buttons are blue; red only for delete/cancel.
- [ ] Detail views open read-only, with Edit.
