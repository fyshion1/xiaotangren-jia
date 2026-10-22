import os
import unittest
from unittest.mock import Mock, patch

import psutil
from fastapi import HTTPException

from app.routers import system


class ProcessTests(unittest.TestCase):
    def test_path_boundary_and_relative_args(self):
        self.assertTrue(system._under_repo(str(system.REPO / 'backend' / 'python.exe')))
        self.assertFalse(system._under_repo(str(system.REPO) + '-other/python.exe'))
        self.assertFalse(system._under_repo('app.main:app'))
        self.assertFalse(system._under_repo(''))

    def test_current_and_ancestors_are_protected(self):
        for pid in system._protected():
            self.assertFalse(system._why(psutil.Process(pid))[0])

    def test_editor_tool_cwd_is_not_project_ownership(self):
        proc = Mock()
        proc.cmdline.return_value = ['C:/other/python.exe', '-m', 'omnireach', 'mcp']
        proc.cwd.return_value = str(system.REPO)
        self.assertFalse(system._project(proc))

    def test_reused_pid_rejected_before_signals(self):
        proc = Mock()
        proc.create_time.return_value = 200
        with patch.object(system.psutil, 'Process', return_value=proc):
            with self.assertRaises(HTTPException) as error:
                system.kill_process(123, system.StopIn(create_time=100, force=True))
        self.assertEqual(error.exception.status_code, 409)
        proc.send_signal.assert_not_called()

    def test_external_project_rejected_even_with_force(self):
        proc = Mock()
        proc.create_time.return_value = 100
        with patch.object(system.psutil, 'Process', return_value=proc), \
                patch.object(system, '_why', return_value=(True, True, 'confirm')), \
                patch.object(system, '_project', return_value=False):
            with self.assertRaises(HTTPException) as error:
                system.kill_process(123, system.StopIn(create_time=100, force=True))
        self.assertEqual(error.exception.status_code, 403)
        proc.send_signal.assert_not_called()

    def test_unowned_requires_confirmation(self):
        proc = Mock()
        proc.create_time.return_value = 100
        with patch.object(system.psutil, 'Process', return_value=proc), \
                patch.object(system, '_why', return_value=(True, True, 'confirm')), \
                patch.object(system, '_project', return_value=True):
            with self.assertRaises(HTTPException) as error:
                system.kill_process(123, system.StopIn(create_time=100))
        self.assertEqual(error.exception.status_code, 409)
        proc.send_signal.assert_not_called()

    def test_surviving_child_means_failure(self):
        parent, child = Mock(pid=123), Mock(pid=124)
        parent.create_time.return_value = 100
        parent.children.return_value = [child]
        child.children.return_value = []
        with patch.object(system.psutil, 'Process', return_value=parent), \
                patch.object(system, '_why', return_value=(True, False, '')), \
                patch.object(system, '_project', return_value=True), \
                patch.object(system, '_protected', return_value={os.getpid()}), \
                patch.object(system.psutil, 'wait_procs', side_effect=[([], [child]), ([], [child])]):
            result = system.kill_process(123, system.StopIn(create_time=100))
        self.assertFalse(result['ok'])
        self.assertEqual(result['remaining'], [124])
        child.kill.assert_called_once()
