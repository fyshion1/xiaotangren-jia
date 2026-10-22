"""Read-only review hints. Shared evidence does not prove duplication or contradiction."""
from __future__ import annotations


def annotate(items: list[dict], persona_id: str) -> list[dict]:
    def evidence_ids(item):
        return {e['id'] for e in item.get('evidence', []) if isinstance(e, dict)
                and isinstance(e.get('id'), str) and e['id']}

    protected = [m for m in items if m.get('persona_id') == persona_id
                 and (m.get('review_status') == 'approved' or m.get('user_edited'))
                 and m.get('review_status') not in {'rejected', 'archived'}]
    output = []
    for item in items:
        related = []
        if item.get('persona_id') == persona_id and item.get('review_status') == 'pending':
            ids = evidence_ids(item)
            for prior in protected:
                if prior['id'] == item['id'] or not item.get('session_id') or prior.get('session_id') != item['session_id']:
                    continue
                if prior.get('feature_id', '') != item.get('feature_id', ''):
                    continue
                if prior.get('scope') != item.get('scope') or set(prior.get('character_ids', [])) != set(item.get('character_ids', [])):
                    continue
                overlap = sorted(ids & evidence_ids(prior))
                if overlap:
                    related.append({'id': prior['id'], 'text': prior['text'],
                                    'review_status': prior['review_status'],
                                    'reason': 'shared_source_messages', 'source_ids': overlap})
        output.append({**item, 'related_reviewed': related})
    return output
