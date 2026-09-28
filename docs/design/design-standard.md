# Leyble Hub design standard

The rules every screen follows, so the same job looks and works the same way everywhere.
They came out of the 2026-09-28 UI audit (phone and tablet screenshots of every screen,
ranked findings F1–F23). The captain answered the audit's design questions on 2026-09-28:
every recommendation was adopted except Q12, where the captain chose icons only.

Each rule lives in code, not in copies. When a screen needs one of these patterns, use the
shared piece named under the rule. Do not restyle it locally.

| Rule | Shared code |
|---|---|
| Page frame and spacing (Q11) | `client/src/components/ui/Page.jsx` |
| Page header row, extra actions (Q2, Q9) | `client/src/components/ui/PageHeader.jsx` |
| Search and filters (Q3) | `client/src/components/ui/SearchFilterBar.jsx` |
| Chip rows (Q4) | `client/src/components/ui/ChipRow.jsx` |
| Status and stock badges (Q5) | `client/src/utils/statusBadges.js`, `client/src/components/ui/Badge.jsx` |
| Phone list card (Q6) | `client/src/components/ui/ListCard.jsx` |
| Icons (Q10) | `client/src/components/layout/NavIcon.jsx` |
| Read-first detail panels (Q13) | `client/src/components/ui/DetailList.jsx` |
| Main buttons, 48px targets (Q8, Q14) | `client/src/components/ui/Button.jsx` |
| Money (Q15) | `client/src/utils/money.js` |
| Going back | `client/src/components/ui/BackLink.jsx` |

---

## Q1. Where phone layout ends and tablet layout begins

**Decision:** the layout switches at **768px** (Tailwind `md:`). Below it, lists are cards and
controls stack. From 768px up, lists are tables. So a Pixel Tablet held upright (800px) gets
the tables, and so does a landscape tablet (1280px). Tables hide their least important
columns until 1024px (`lg:`) so they fit 800px without scrolling sideways.

**Considered:**
- *Keep the switch at 1024px:* already in the code, but an upright tablet got stretched
  phone cards with an empty middle (audit F15).
- *Three layouts (phone / small tablet / big tablet):* the best fit everywhere, but about
  1.5× the screens to build and check.

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
| Waiting to sync, Possible duplicate, Not printed | amber |
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

**Decision:** one recipe for every list (`ListCard`):
1. **Line 1:** what it is (a customer, product, supplier or ticket name), with the money or
   key number on the right. The name wraps onto as many lines as it needs and is **never
   cut short**.
2. **Line 2:** the one most useful detail (receipt number · date, SKU, phone), with a
   secondary fact on the right (Sold by, In stock, Logged by).
3. **Line 3:** badges, **only when there is something to say**, plus any per-row action.

The whole card is the tap target. An ordinary state gets no badge: no "Active" on every
customer.

**Considered:**
- *Each screen designs its own card:* that produced five different cards (audit F21).
- *Tables on phones with sideways scroll:* the same as tablet, but slow, and it hides the
  money column.

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
| 800×1280 | tablet held upright |
| 1280×800 | tablet held sideways |

**Considered:**
- *412 phone + 1280 tablet only:* fewer images, but it would have missed the 360px problems
  (audit F1, F6) and the upright-tablet one (F15).

### Checklist (run it on each of the four screenshots)

- [ ] No sideways page scroll, and nothing clipped at the right edge (money especially).
- [ ] Header: title and main button on one row; extras follow Q9.
- [ ] Search is full width; everything else is in Filters; active filters show as chips.
- [ ] Chip rows scroll on one line; nothing wraps.
- [ ] Every status or stock state has a word, in the Q5 colour.
- [ ] Phone cards follow the Q6 recipe; names are not cut short.
- [ ] No text under 14px; no text lighter than slate-500.
- [ ] Every tappable thing is at least 48px tall.
- [ ] Icons come from `NavIcon`; no emoji used as an icon.
- [ ] Money follows Q15.
- [ ] Main buttons are blue; red only for delete/cancel.
- [ ] Detail views open read-only, with Edit.
