// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DropLedger} from "../src/DropLedger.sol";

/// @notice Minimal mock of the Agent ID ERC-721: only balanceOf matters.
contract MockAgentId {
    mapping(address => uint256) public balanceOf;

    function mint(address to) external {
        balanceOf[to] = 1;
    }

    function burn(address from) external {
        balanceOf[from] = 0;
    }
}

contract DropLedgerTest is Test {
    DropLedger internal ledger;
    MockAgentId internal agentId;

    address internal holder = makeAddr("holder");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        agentId = new MockAgentId();
        ledger = new DropLedger(address(agentId));
        agentId.mint(holder);
    }

    // -- Agent ID gate ------------------------------------------------------

    function test_NonHolderCannotCreateProject() public {
        vm.prank(stranger);
        vm.expectRevert(DropLedger.AgentIdRequired.selector);
        ledger.createProject("Fungo", "Ethereum", "main", "");
    }

    function test_NonHolderCannotWriteAnything() public {
        vm.prank(holder);
        uint256 pid = ledger.createProject("Fungo", "Ethereum", "main", "");

        vm.prank(stranger);
        vm.expectRevert(DropLedger.AgentIdRequired.selector);
        ledger.updateProjectStatus(pid, DropLedger.ProjectStatus.Paused);

        vm.prank(stranger);
        vm.expectRevert(DropLedger.AgentIdRequired.selector);
        ledger.addTask(pid, "Connect wallet", DropLedger.TaskKind.OnChain, false);

        vm.prank(stranger);
        vm.expectRevert(DropLedger.AgentIdRequired.selector);
        ledger.setTaskDone(pid, 0, true);
    }

    function test_HolderLosesAccessAfterBurn() public {
        agentId.burn(holder);
        vm.prank(holder);
        vm.expectRevert(DropLedger.AgentIdRequired.selector);
        ledger.createProject("Fungo", "Ethereum", "main", "");
    }

    function test_ReadsArePublic() public {
        vm.prank(holder);
        ledger.createProject("Fungo", "Ethereum", "main", "");
        // A stranger can read without an Agent ID.
        assertEq(ledger.getProjectCount(holder), 1);
        assertEq(ledger.isAgentHolder(stranger), false);
        assertEq(ledger.isAgentHolder(holder), true);
    }

    // -- Projects -----------------------------------------------------------

    function test_CreateProject() public {
        vm.prank(holder);
        uint256 pid = ledger.createProject("Fungo", "Ethereum", "main", "genesis #272");
        assertEq(pid, 0);
        assertEq(ledger.getProjectCount(holder), 1);

        DropLedger.Project memory p = ledger.getProject(holder, 0);
        assertEq(p.name, "Fungo");
        assertEq(p.chainName, "Ethereum");
        assertEq(p.walletLabel, "main");
        assertEq(p.notes, "genesis #272");
        assertEq(uint8(p.status), uint8(DropLedger.ProjectStatus.Active));
        assertEq(p.taskCount, 0);
        assertEq(p.tasksDone, 0);
        assertEq(p.createdAt, uint64(block.timestamp));
        assertEq(p.lastActivityAt, uint64(block.timestamp));
    }

    function test_CreateProjectEmptyNameReverts() public {
        vm.prank(holder);
        vm.expectRevert(DropLedger.EmptyName.selector);
        ledger.createProject("", "Ethereum", "main", "");
    }

    function test_UpdateStatusAndNotes() public {
        vm.prank(holder);
        uint256 pid = ledger.createProject("Fungo", "Ethereum", "main", "");
        vm.warp(block.timestamp + 100);

        vm.prank(holder);
        ledger.updateProjectStatus(pid, DropLedger.ProjectStatus.TGE);
        DropLedger.Project memory p = ledger.getProject(holder, pid);
        assertEq(uint8(p.status), uint8(DropLedger.ProjectStatus.TGE));
        assertEq(p.lastActivityAt, uint64(block.timestamp));

        vm.prank(holder);
        ledger.updateProjectNotes(pid, "claimed");
        assertEq(ledger.getProject(holder, pid).notes, "claimed");
    }

    function test_UnknownProjectReverts() public {
        vm.prank(holder);
        vm.expectRevert(DropLedger.ProjectNotFound.selector);
        ledger.updateProjectStatus(0, DropLedger.ProjectStatus.Ended);
        vm.expectRevert(DropLedger.ProjectNotFound.selector);
        ledger.getProject(holder, 0);
    }

    // -- Tasks --------------------------------------------------------------

    function test_AddAndCompleteTask() public {
        vm.prank(holder);
        uint256 pid = ledger.createProject("VOICE", "Ethereum", "main", "");

        vm.prank(holder);
        uint256 tid = ledger.addTask(pid, "Daily tasks", DropLedger.TaskKind.Daily, true);
        assertEq(tid, 0);
        assertEq(ledger.getTaskCount(holder, pid), 1);

        DropLedger.Task memory t = ledger.getTask(holder, pid, 0);
        assertEq(t.title, "Daily tasks");
        assertEq(uint8(t.kind), uint8(DropLedger.TaskKind.Daily));
        assertTrue(t.recurring);
        assertFalse(t.done);
        assertEq(t.completedAt, 0);

        vm.warp(block.timestamp + 50);
        vm.prank(holder);
        ledger.setTaskDone(pid, 0, true);
        t = ledger.getTask(holder, pid, 0);
        assertTrue(t.done);
        assertEq(t.completedAt, uint64(block.timestamp));
        assertEq(ledger.getProject(holder, pid).tasksDone, 1);

        // Un-do it again.
        vm.prank(holder);
        ledger.setTaskDone(pid, 0, false);
        t = ledger.getTask(holder, pid, 0);
        assertFalse(t.done);
        assertEq(t.completedAt, 0);
        assertEq(ledger.getProject(holder, pid).tasksDone, 0);
    }

    function test_SetTaskDoneIsIdempotent() public {
        vm.prank(holder);
        uint256 pid = ledger.createProject("VOICE", "Ethereum", "main", "");
        vm.prank(holder);
        ledger.addTask(pid, "Daily tasks", DropLedger.TaskKind.Daily, true);

        vm.prank(holder);
        ledger.setTaskDone(pid, 0, true);
        vm.prank(holder);
        ledger.setTaskDone(pid, 0, true); // no-op, must not double-count
        assertEq(ledger.getProject(holder, pid).tasksDone, 1);
    }

    function test_AddTaskEmptyTitleReverts() public {
        vm.prank(holder);
        uint256 pid = ledger.createProject("VOICE", "Ethereum", "main", "");
        vm.prank(holder);
        vm.expectRevert(DropLedger.EmptyTitle.selector);
        ledger.addTask(pid, "", DropLedger.TaskKind.Other, false);
    }

    function test_UnknownTaskReverts() public {
        vm.prank(holder);
        uint256 pid = ledger.createProject("VOICE", "Ethereum", "main", "");
        vm.prank(holder);
        vm.expectRevert(DropLedger.TaskNotFound.selector);
        ledger.setTaskDone(pid, 0, true);
    }

    function test_BatchAdd() public {
        vm.prank(holder);
        uint256 pid = ledger.createProject("PXIO", "BSC", "agent", "");

        string[] memory titles = new string[](3);
        titles[0] = "Mint miner";
        titles[1] = "Start mining";
        titles[2] = "Claim PXIO";
        DropLedger.TaskKind[] memory kinds = new DropLedger.TaskKind[](3);
        kinds[0] = DropLedger.TaskKind.OnChain;
        kinds[1] = DropLedger.TaskKind.OnChain;
        kinds[2] = DropLedger.TaskKind.Daily;
        bool[] memory recs = new bool[](3);
        recs[2] = true;

        vm.prank(holder);
        uint256 first = ledger.addTasksBatch(pid, titles, kinds, recs);
        assertEq(first, 0);
        assertEq(ledger.getTaskCount(holder, pid), 3);
        assertEq(ledger.getProject(holder, pid).taskCount, 3);
        assertEq(ledger.getTask(holder, pid, 2).title, "Claim PXIO");
        assertTrue(ledger.getTask(holder, pid, 2).recurring);
    }

    function test_BatchLengthMismatchReverts() public {
        vm.prank(holder);
        uint256 pid = ledger.createProject("PXIO", "BSC", "agent", "");

        string[] memory titles = new string[](2);
        titles[0] = "a";
        titles[1] = "b";
        DropLedger.TaskKind[] memory kinds = new DropLedger.TaskKind[](1);
        bool[] memory recs = new bool[](2);

        vm.prank(holder);
        vm.expectRevert(DropLedger.BatchLengthMismatch.selector);
        ledger.addTasksBatch(pid, titles, kinds, recs);
    }

    // -- Stats + activity ---------------------------------------------------

    function test_StatsMath() public {
        vm.startPrank(holder);
        uint256 p0 = ledger.createProject("A", "Ethereum", "w1", "");
        uint256 p1 = ledger.createProject("B", "BSC", "w2", "");
        ledger.addTask(p0, "t1", DropLedger.TaskKind.Social, false);
        ledger.addTask(p0, "t2", DropLedger.TaskKind.OnChain, false);
        ledger.addTask(p1, "t3", DropLedger.TaskKind.Testnet, false);
        ledger.setTaskDone(p0, 0, true);
        vm.stopPrank();

        (uint256 projects, uint256 done, uint256 remaining) = ledger.getStats(holder);
        assertEq(projects, 2);
        assertEq(done, 1);
        assertEq(remaining, 2);

        (projects, done, remaining) = ledger.getStats(stranger);
        assertEq(projects, 0);
        assertEq(done, 0);
        assertEq(remaining, 0);
    }

    function test_LastActivityBumpsOnEveryWrite() public {
        vm.prank(holder);
        uint256 pid = ledger.createProject("A", "Ethereum", "w1", "");
        uint64 created = ledger.getProject(holder, pid).lastActivityAt;

        vm.warp(block.timestamp + 1000);
        vm.prank(holder);
        ledger.addTask(pid, "t1", DropLedger.TaskKind.Social, false);
        assertEq(ledger.getProject(holder, pid).lastActivityAt, created + 1000);

        vm.warp(block.timestamp + 500);
        vm.prank(holder);
        ledger.setTaskDone(pid, 0, true);
        assertEq(ledger.getProject(holder, pid).lastActivityAt, created + 1500);
    }

    function test_UsersAreIsolated() public {
        address holder2 = makeAddr("holder2");
        agentId.mint(holder2);

        vm.prank(holder);
        ledger.createProject("Mine", "Ethereum", "w1", "");
        vm.prank(holder2);
        ledger.createProject("Theirs", "BSC", "w2", "");

        assertEq(ledger.getProjectCount(holder), 1);
        assertEq(ledger.getProjectCount(holder2), 1);
        assertEq(ledger.getProject(holder, 0).name, "Mine");
        assertEq(ledger.getProject(holder2, 0).name, "Theirs");

        // holder2 cannot touch holder's project 0 (it is a different project:
        // holder2's own project 0) — writes only ever affect msg.sender.
        vm.prank(holder2);
        ledger.updateProjectNotes(0, "theirs");
        assertEq(ledger.getProject(holder, 0).notes, "");
    }
}
