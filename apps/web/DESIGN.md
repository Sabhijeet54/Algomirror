# AlgoMirror public pages: design notes

Scope: the landing page (`/`) and the brand panel of the sign-in / register layout. The signed-in app
(dashboard, master desk, automation) keeps its own UI and is not covered here.

## Brief

- Subject: AlgoMirror, strategy copy trading for Indian markets (NSE, BSE, F&O).
- Audience: retail followers deciding whether to connect a broker; masters arriving to sign in.
- Job: explain in 3 seconds what happens to your account, build trust (your broker, your limits,
  nothing starts on its own), then get them to Create account or Sign in.
- No new claims. Every fact on the page already appeared in the old copy (brokers, risk checks,
  real executions, paper trading, risk disclaimer).

## Concept

| | Idea | Anchor | Signature | O/F/Fe/P |
|---|---|---|---|---|
| A. Name | The page is a mirror: a seam splits it, the master's order is on one side, its reflection in your account on the other | the product literally reflects a master's executions into followers' accounts | an order ticket is executed on the left and reappears on the right, resized to your allocation after the checks pass | 4 / 5 / 5 / 2 |
| B. Material | The page is a broker contract note: rows, timestamps, tabular figures | trading paperwork | rows print in as you scroll | 3 / 4 / 5 / 3 |
| C. Process | Every order walks through four gates before it reaches you | the risk checks run before each follower order | gates open one by one | 3 / 4 / 4 / 2 |

Pick A: it fits the name and the mechanism, and stays cheap to build well. From C: the
"what we check" section is the list of gates, in the order they run.

```
Idea:        A seam down the page: the master's trade on one side, its reflection in your account on the other.
Metaphor:    a mirror line, with the risk checks as the glass the order passes through
Signature:   the mirrored ticket; an order executes on the left, the four checks tick, and it reappears on the right at your size
Emotion:     calm control; you see your account follow, smaller and checked
Motion verb: reflect (things flip across an axis and settle)
Screenshot:  the two tickets either side of the seam, master 10 lots, yours 2 lots, four checks passed
```

## System

- Palette (light, committed for these pages):
  - ground `#eef0f2`: cool terminal grey, not cream
  - ink `#0c0d10`
  - muted `#555b65`: AA on ground
  - line `rgba(12,13,16,.14)`
  - accent `#5a1fe6`: the app's violet, darkened for AA, used only on "your" side of the mirror
  - curtain `#0c0d10`: the finale band
  The violet is the existing brand colour, so it stays, as a flat accent only. No gradients.
- Type: Archivo variable, self-hosted. Display is set expanded (width 112 to 125, weight 700 to 800,
  tracking -0.035em). Text is Archivo at normal width, 400/500. Geist Mono is used for ticket data only.
- Grid: 12 columns, gutter `clamp(16px, 2.4vw, 32px)`. The seam sits on the line between columns 6 and 7.
- Shape: radius 0 for structure, 999px only for the two CTA pills.
- Motion: one ease `cubic-bezier(.22,1,.36,1)`, 600 to 900 ms for large moves and 250 ms for hovers.
  The ticket cycle is the idle motion. It pauses off screen and when the tab is hidden. Under reduced
  motion the first example is shown still.
- Hovers: CTAs flood with fill from the seam side and the label rolls. Brand-list and footer links
  only change colour.

## Sections

```
[ wordmark                                   sign in · create account ]
[ display: their trade.    |    display: your account.               ]
[ master ticket            |    your ticket (after 4 checks)          ]   <- signature
[ statement paragraph across 9 cols                                   ]
[ the four checks, as rows in the order they run                      ]
[ supported brokers, one line of type                                 ]
[ curtain: wordmark with its reflection, CTAs, risk text              ]
```

## Genericness test

- The old page had a centered hero and a four-card grid with icons. That is now a split hero and a
  list of checks.
- The old auth panel used a violet blob gradient. It is now a flat ink panel with the seam.
- Geist is the default developer font; the display face is now Archivo expanded.
- No eyebrow label above every heading, and no em dashes in the copy.
