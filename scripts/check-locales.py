#!/usr/bin/env python3
"""Validate locale files against locales/uk.yaml (the reference locale).

Checks per locale: YAML parses, key set matches uk, ${placeholders} match,
HTML tag counts match, and the text is written in the expected script.

Usage: python3 scripts/check-locales.py [lang ...]
"""
import collections
import glob
import os
import re
import sys

import yaml

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'locales')

SCRIPT_RE = {
    'cyr': re.compile(r'[Ѐ-ӿ]'),
    'lat': re.compile(r'[A-Za-zÀ-ɏ]'),
    'arab': re.compile(r'[؀-ۿ]'),
    'arm': re.compile(r'[԰-֏]'),
    'cjk': re.compile(r'[぀-ヿ一-鿿]'),
}
EXPECTED = {
    'uk': 'cyr', 'ru': 'cyr', 'be': 'cyr', 'kk': 'cyr',
    'ar': 'arab', 'hy': 'arm', 'ja': 'cjk', 'zh': 'cjk',
    'en': 'lat', 'de': 'lat', 'es': 'lat', 'fr': 'lat', 'pt': 'lat',
    'tr': 'lat', 'id': 'lat', 'az': 'lat', 'uz': 'lat',
}
# Letters that never occur in the given Cyrillic language
FOREIGN_CYR = {
    'uk': set('ыэъёўәғқңөұүһЫЭЪЁЎӘҒҚҢӨҰҮҺ'),
    'ru': set('іїєґўәғқңөұүһІЇЄҐЎӘҒҚҢӨҰҮҺ'),
    'be': set('иїєґщъәғқңөұүһИЇЄҐЩЪӘҒҚҢӨҰҮҺ'),
    'kk': set('їєґўЇЄҐЎ'),
}
TAG_RE = re.compile(r'</?(b|i|u|s|code|pre|a|blockquote|tg-spoiler)\b')
PLACEHOLDER_RE = re.compile(r'\$\{[^}]*\}')


def flatten(node, prefix=''):
    if isinstance(node, dict):
        for k, v in node.items():
            yield from flatten(v, f'{prefix}.{k}' if prefix else str(k))
    else:
        yield prefix, node


def strip_markup(s):
    # Drop tags without a gap so links like t.me/addstickers/<u>Name</u> stay one token
    s = re.sub(r'<[^>]+>', '', s)
    s = PLACEHOLDER_RE.sub(' ', s)
    s = re.sub(r'https?://\S+|\S+\.\S+/\S*|@\w+|/\w+|#\w+', ' ', s)
    s = re.sub(r'\b(fStik\w*|Unicode|Telegram|Stars?|GIF|WebM|TGS|MP4|PNG|WEBP|Android|WebApp|BiRefNet|Inline|lite|medium|rounded|circle)\b', ' ', s, flags=re.I)
    return s


def load(lang):
    with open(os.path.join(ROOT, f'{lang}.yaml'), encoding='utf-8') as f:
        return dict(flatten(yaml.safe_load(f)))


def check(lang, ref):
    problems = []
    try:
        data = load(lang)
    except yaml.YAMLError as e:
        return [f'YAML error: {e}']

    for k in ref:
        if k not in data:
            problems.append(f'missing key: {k}')
    for k in data:
        if k not in ref:
            problems.append(f'extra key: {k}')

    expected = EXPECTED.get(lang)
    for k, v in data.items():
        if k not in ref:
            continue
        if not isinstance(v, str) or not isinstance(ref[k], str):
            if type(v) is not type(ref[k]):
                problems.append(f'{k}: type {type(v).__name__} != {type(ref[k]).__name__}')
            continue
        # Placeholders must be ones the code actually passes (those used in uk)
        known = set(PLACEHOLDER_RE.findall(ref[k]))
        unknown = sorted(set(PLACEHOLDER_RE.findall(v)) - known)
        if unknown:
            problems.append(f'{k}: placeholders not used in uk: {unknown}')
        dropped = sorted(known - set(PLACEHOLDER_RE.findall(v)))
        if dropped:
            problems.append(f'{k}: placeholders dropped vs uk: {dropped}')
        opened = collections.Counter(m.group(1) for m in TAG_RE.finditer(v) if not m.group(0).startswith('</'))
        closed = collections.Counter(m.group(1) for m in TAG_RE.finditer(v) if m.group(0).startswith('</'))
        if opened != closed:
            problems.append(f'{k}: unbalanced HTML tags')
        if v.strip() == '' and ref[k].strip() != '':
            problems.append(f'{k}: empty value')

        text = strip_markup(v)
        counts = {s: len(r.findall(text)) for s, r in SCRIPT_RE.items()}
        total = sum(counts.values())
        if expected and total >= 3:
            for s, n in counts.items():
                if s != expected and n >= 3 and n / total > 0.25:
                    problems.append(f'{k}: {n}/{total} letters in {s} script :: {v[:80]!r}')
        if lang in FOREIGN_CYR:
            bad = sorted({ch for ch in text if ch in FOREIGN_CYR[lang]})
            if bad:
                problems.append(f'{k}: letters foreign to {lang}: {"".join(bad)}')
    return problems


def main():
    ref = load('uk')
    langs = sys.argv[1:] or sorted(os.path.basename(p)[:-5] for p in glob.glob(os.path.join(ROOT, '*.yaml')))
    failed = False
    for lang in langs:
        problems = check(lang, ref)
        print(f'{lang}: {"OK" if not problems else f"{len(problems)} problem(s)"}')
        for p in problems:
            print(f'  {p}')
        failed = failed or bool(problems)
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
