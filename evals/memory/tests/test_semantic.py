"""No network: verify budget stops, failures, evidence binding and unreviewed states."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import semantic as target


class SemanticHarnessTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.plan = target.prepare(target.HERE / 'cases.json', self.root / 'plans', 3)
        self.config = {'base_url': 'https://eval.invalid/v1', 'model': 'synthetic-test',
                       'max_tokens': 1024, 'timeout_seconds': 1, 'input_price_per_million': '1',
                       'output_price_per_million': '1', 'currency': 'TEST', 'max_estimated_cost': '1',
                       'price_source': 'fake test tariff, not a real price', 'price_checked_date': '2026-10-19'}

    def response(self, payload):
        return {'choices': [{'message': {'content': '{"memories":[]}'}, 'finish_reason': 'stop'}],
                'usage': {'prompt_tokens': 30, 'completion_tokens': 10, 'total_tokens': 40}}

    def execute(self, send=None, **config):
        return target.execute(self.plan, {**self.config, **config}, 'private-test-key',
                              self.root / 'runs', send=send or self.response)

    def test_valid_empty_output_remains_unreviewed(self):
        result = target.read(self.execute())
        self.assertEqual([r['status'] for r in result['results'][:3]], ['needs_review'] * 3)
        self.assertEqual(sum(r['status'] == 'not_run' for r in result['results']), 9)
        self.assertEqual(result['release_gate'], 'not_assessed')

    def test_budget_prevents_any_request(self):
        calls = []
        path = self.execute(lambda p: calls.append(p), max_estimated_cost='0.00000001')
        self.assertEqual(calls, [])
        self.assertTrue(all(r['status'] == 'not_run' for r in target.read(path)['results']))

    def test_invalid_price_is_not_treated_as_free(self):
        with self.assertRaises(ValueError):
            self.execute(input_price_per_million=None)
        with self.assertRaises(ValueError):
            self.execute(input_price_per_million='NaN')

    def test_missing_usage_stops_after_one_attempt(self):
        calls = []
        def send(payload):
            calls.append(payload)
            response = self.response(payload)
            response.pop('usage')
            return response
        report = target.read(self.execute(send))
        self.assertEqual(len(calls), 1)
        self.assertEqual(report['results'][0]['status'], 'needs_review')
        self.assertTrue(report['usage_cost_incomplete'])
        self.assertEqual(report['results'][1]['status'], 'not_run')

    def test_failed_request_is_not_retried_or_empty_success(self):
        calls = []
        def send(payload):
            calls.append(payload)
            raise RuntimeError('credential private-test-key')
        path = self.execute(send)
        self.assertEqual(len(calls), 1)
        self.assertEqual(target.read(path)['results'][0]['status'], 'error')
        self.assertNotIn('private-test-key', path.read_text(encoding='utf-8'))

    def test_truncation_is_a_failure(self):
        def send(payload):
            response = self.response(payload)
            response['choices'][0]['finish_reason'] = 'length'
            return response
        self.assertEqual(target.read(self.execute(send))['results'][0]['status'], 'protocol_fail')

    def test_fabricated_evidence_ids_fail_protocol(self):
        raw = json.dumps({'memories': [{'text': '虚构', 'source_ids': ['fake-id'],
                                       'kind': 'memory', 'category': 'experience'}]})
        self.assertTrue(target.protocol(raw, ['s01-1']))

    def test_secret_echo_is_redacted_from_artifacts(self):
        def send(payload):
            response = self.response(payload)
            response['choices'][0]['message']['content'] = json.dumps({'memories': [
                {'text': 'private-test-key', 'source_ids': ['s01-1'], 'kind': 'memory', 'category': 'experience'}]})
            return response
        path = self.execute(send)
        for artifact in path.parent.glob('*.json'):
            self.assertNotIn('private-test-key', artifact.read_text(encoding='utf-8'))

    def test_review_requires_all_criteria_and_evidence(self):
        results = self.execute()
        template = results.parent / 'review-template.json'
        pending = target.review(results, template)
        self.assertEqual(target.read(pending)['counts']['needs_review'], 3)
        judgments = target.read(template)
        judgments['cases'][0]['criteria'][0]['verdict'] = 'pass'
        target.write(template, judgments)
        with self.assertRaises(ValueError):
            target.review(results, template)
        judgments['reviewer'] = 'test-fixture-reviewer'
        for c in judgments['cases'][0]['criteria']:
            c.update(verdict='pass', evidence='Fixture-only judgment, not a real model assessment')
        target.write(template, judgments)
        report = target.read(target.review(results, template))
        self.assertEqual(report['counts']['semantic_pass'], 1)
        self.assertEqual(report['counts']['needs_review'], 2)

    def test_tampered_result_cannot_reuse_old_review(self):
        results = self.execute()
        report = target.read(results)
        report['results'][0]['raw_output'] = 'changed'
        target.write(results, report)
        with self.assertRaises(ValueError):
            target.review(results, results.parent / 'review-template.json')

    def test_default_run_requires_execute_before_reading_config(self):
        with patch.object(sys, 'argv', ['semantic.py', 'run', '--plan', 'missing', '--config', 'missing']):
            with self.assertRaisesRegex(ValueError, '--execute'):
                target.main()

    def test_requests_use_production_cleaning_and_no_expected_answers(self):
        plan = target.read(self.plan)
        request = plan['cases'][0]['request_messages']
        self.assertEqual([m['role'] for m in request], ['system', 'user'])
        self.assertIn('消息编号=s01-1', request[1]['content'])
        self.assertNotIn(plan['cases'][0]['expected_behavior'], request[1]['content'])

    def test_http_path_sends_bounded_payload_without_tools(self):
        import httpx
        calls = []
        real_client = httpx.Client
        def handle(request):
            payload = json.loads(request.content)
            calls.append(payload)
            self.assertEqual(request.headers['Authorization'], 'Bearer private-test-key')
            self.assertEqual(payload['max_tokens'], 1024)
            self.assertNotIn('tools', payload)
            return httpx.Response(200, json=self.response(payload))
        with patch('httpx.Client', side_effect=lambda **kw: real_client(transport=httpx.MockTransport(handle), **kw)):
            path = target.execute(self.plan, self.config, 'private-test-key', self.root / 'runs')
        self.assertEqual(len(calls), 3)
        self.assertEqual(target.read(path)['results'][0]['status'], 'needs_review')

    def test_http_429_does_not_retry_or_store_error_body(self):
        import httpx
        calls = []
        real_client = httpx.Client
        def handle(request):
            calls.append(request)
            return httpx.Response(429, text='sensitive provider error private-test-key')
        with patch('httpx.Client', side_effect=lambda **kw: real_client(transport=httpx.MockTransport(handle), **kw)):
            path = target.execute(self.plan, self.config, 'private-test-key', self.root / 'runs')
        self.assertEqual(len(calls), 1)
        self.assertEqual(target.read(path)['results'][0]['http_status'], 429)
        self.assertNotIn('sensitive provider error', path.read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main()
