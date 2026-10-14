# Interface Principles

Status: Active

These rules apply to product UI, prototypes, and implementation reviews.

## 1. The interface should explain itself

Do not add prose that teaches users how to use an otherwise familiar control.
For example, do not place copy such as “用你自己的說法問問題，系統會跨主題、
跨來源比對原始內容，並把命中的片段當成證據列出來” above search.

Communicate capability through the interaction itself:

- name controls by the object users can act on;
- use real, selectable examples when query shape is unfamiliar;
- expose matched source excerpts directly in results;
- make source, author, time, and provenance visible at the point of use;
- use state, hierarchy, and feedback before adding explanatory text.

Helper copy is reserved for errors, irreversible actions, unfamiliar constraints,
and accessibility needs. Product roadmaps and implementation notes do not belong
in the primary experience.

## 2. Interface strings are localizable

All product-owned interface strings use translation keys. The initial supported
locales are Traditional Chinese (`zh-Hant`) and English (`en`). A selected locale
persists across sessions.

Upstream evidence remains in its original language. A translated or generated
view must be visibly derived and must retain a link to the original evidence;
translation must never silently replace canonical source content.

## 3. Validate the behavior, not the explanation

A search experience is understandable when a user can enter or select a query,
recognize why each result matched, and open its source without reading onboarding
prose. Review desktop and mobile layouts in every supported locale because text
length is part of responsive behavior.

## 4. One word per object

Owner decision 2026-10-14 (統一用討論): in `zh-Hant`, the object a Feed card, a
search result, and a detail page stand for — a GitHub pull request, a dev@
thread, or a Jira issue — is 「討論」. Do not call it 「主題」.

「主題」 remains only for the Spec 014 digest topic, a taxonomy group of
threads: `digest.topics`, `digest.anchor.topics`, and `topic.breadcrumb`
(「開發主題」). `apps/web/test/i18n-terms.test.ts` (`TERM1`) fails when any other
`zh-Hant` string uses the word.

The English catalogue still says "topic" for a thread in several places
(`card.open`, `rail.related`, `stats.feed`); the decision covered `zh-Hant`.
