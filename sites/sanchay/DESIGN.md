# Sanchay Technologies: design notes

## Brief
- Subject: Sanchay Technologies, an Indian software company that builds automated trading
  platforms (the product runs at trade.sanchaytechnologies.com).
- Audience: B2B buyers. Brokers and authorised persons, advisors, trader-educators who run client
  groups, small desks. Also individual clients who want an account.
- Job: get enquiries (client or partner), send existing users to Log in / Sign up.
- Constraints: static files on Hostinger Premium shared hosting. Forms post to the platform API.
  No fake numbers, no client logos, no returns promised.
- Assumptions to replace: company legal name, registered address, GST, grievance email and phone
  (legal pages point to the contact form until these are given). Logo is a first version.

## Concepts
| | Idea | Anchor | Signature | O/F/Fe/P |
|---|---|---|---|---|
| A. Material | The site is a routing diagram: one order line enters and fans out into many account lines | what the product does (one trade, many accounts) | hero router: packets travel the fan and each account row ticks to FILLED | 4 / 5 / 5 / 2 |
| B. Name | *Sanchay* means gathering, a store built up over time: sections stack like a growing pile | the company name | blocks settle onto a stack as you scroll | 3 / 3 / 4 / 3 |
| C. Formal | Every page is set as an order ticket (fields, codes, timestamps) | trading terminals | ticket fields type themselves in | 3 / 3 / 4 / 4 |

Pick A. It explains the product in one look and every section can hang off the route. Steal from B
for the logo: a stack of three bars that grow, joined by one stem (one signal, accumulating accounts).

## Concept card
```
Idea:        One signal in, every linked account filled, each at its own size.
Metaphor:    a signal router / order fan-out
Signature:   hero router (SVG + GSAP ticker): packets run from SIGNAL along a fan to 8 account rows,
             each row ticks QUEUED -> FILLED with its own quantity; keeps cycling slowly at rest
Emotion:     calm control, nothing frantic
Motion verb: route: lines draw left to right, things arrive and settle with a small tick
Screenshot:  the fan with half the rows filled and one packet mid-line
```

## System
- Palette: ground #EEF0F2 (cool paper), ink #0B1620, muted #4E5D6B (AA on ground), line rgba(11,22,32,.14),
  accent #1F4BFF (cobalt, signals and primary actions only), night #0B1620 for the partner chapter.
- Type: Supreme (Fontshare) for display and text, 400/500/700/800. IBM Plex Mono for order data,
  codes and small labels that carry real data. Display tracking -0.035em, leading 0.95.
- Grid: 12 columns, 24 px gutter (16 on phone), content max 1320 px. Text aligns to column 1 or 7.
- Shape: radius 6 px on controls, 0 on sections.
- Motion: one ease (power3.out / cubic-bezier(.2,.7,.1,1)), 0.5 to 0.9 s, stagger 40 ms.
  Primary buttons: the label slides up inside a clipped line (route = moves along a line).
  Arrow links: arrow travels right. Utility links: colour only.
- Theatre: no loader, no WebGL, no page transitions (a B2B site that must load instantly).
  The router keeps routing at rest (idle motion). Reduced motion shows the finished state.

## Sections (each a different family)
1. Hero: split, headline left, router right (stacked on phone).
2. What we build: index list rows with a mono code column.
3. How it works: a horizontal route of four stops (a real sequence).
4. Brokers: running text line of broker names.
5. Who it is for: two-column statement + list.
6. Partners (night chapter): two large options side by side, different weights.
7. Pricing: one paragraph statement + engagement table.
8. FAQ: details/summary list.
9. Closing CTA + footer with big wordmark.
