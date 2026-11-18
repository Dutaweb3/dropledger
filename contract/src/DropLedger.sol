// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DropLedger
/// @notice An on-chain journal for airdrop farmers: track the projects you
///         follow, the tasks you have done, which wallet you used, and when
///         you last acted — recorded under your Agent ID identity.
/// @dev    Writes are restricted to Agent ID holders (SPACE ID ERC-721,
///         non-transferable, BNB Chain). Reads are public. The contract holds
///         no funds, has no owner, no upgradeability, and no pause switch.
///         Journal entries are public on-chain by design: never log seeds,
///         private keys, or other sensitive information.
interface IAgentID {
    function balanceOf(address owner) external view returns (uint256);
}

contract DropLedger {
    /// @notice The Agent ID registry (SPACE ID ERC-721 on BNB Chain).
    IAgentID public immutable agentId;

    /// @notice Lifecycle of a tracked project.
    enum ProjectStatus {
        Active,
        Paused,
        Ended,
        TGE
    }

    /// @notice Category of a journal task.
    enum TaskKind {
        Social,
        OnChain,
        Testnet,
        Daily,
        Weekly,
        Other
    }

    struct Project {
        string name;
        string chainName;
        string walletLabel;
        string notes;
        ProjectStatus status;
        uint64 createdAt;
        uint64 lastActivityAt;
        uint32 taskCount;
        uint32 tasksDone;
    }

    struct Task {
        string title;
        TaskKind kind;
        bool recurring;
        bool done;
        uint64 createdAt;
        uint64 completedAt;
    }

    mapping(address => Project[]) private _projects;
    mapping(address => mapping(uint256 => Task[])) private _tasks;

    event ProjectCreated(
        address indexed user,
        uint256 indexed projectId,
        string name,
        string chainName
    );
    event ProjectStatusUpdated(
        address indexed user,
        uint256 indexed projectId,
        ProjectStatus status
    );
    event ProjectNotesUpdated(address indexed user, uint256 indexed projectId);
    event TaskAdded(
        address indexed user,
        uint256 indexed projectId,
        uint256 indexed taskId,
        string title,
        TaskKind kind
    );
    event TaskStatusChanged(
        address indexed user,
        uint256 indexed projectId,
        uint256 indexed taskId,
        bool done
    );

    error AgentIdRequired();
    error ProjectNotFound();
    error TaskNotFound();
    error EmptyName();
    error EmptyTitle();
    error BatchLengthMismatch();

    /// @param agentId_ Address of the Agent ID ERC-721 contract.
    constructor(address agentId_) {
        agentId = IAgentID(agentId_);
    }

    /// @dev Only Agent ID holders may write. balanceOf > 0 means the caller
    ///      holds an Agent ID (each user can claim only one, non-transferable).
    modifier onlyAgentHolder() {
        if (agentId.balanceOf(msg.sender) == 0) revert AgentIdRequired();
        _;
    }

    // ------------------------------------------------------------------------
    // Projects
    // ------------------------------------------------------------------------

    /// @notice Create a new tracked project.
    /// @param name Project name (e.g. "Fungo").
    /// @param chainName Chain the project lives on (e.g. "Ethereum").
    /// @param walletLabel Which wallet is used for this project
    ///        (a label, never a seed or private key).
    /// @param notes Free-form notes.
    /// @return projectId Index of the new project for the caller.
    function createProject(
        string calldata name,
        string calldata chainName,
        string calldata walletLabel,
        string calldata notes
    ) external onlyAgentHolder returns (uint256 projectId) {
        if (bytes(name).length == 0) revert EmptyName();
        projectId = _projects[msg.sender].length;
        _projects[msg.sender].push(
            Project({
                name: name,
                chainName: chainName,
                walletLabel: walletLabel,
                notes: notes,
                status: ProjectStatus.Active,
                createdAt: uint64(block.timestamp),
                lastActivityAt: uint64(block.timestamp),
                taskCount: 0,
                tasksDone: 0
            })
        );
        emit ProjectCreated(msg.sender, projectId, name, chainName);
    }

    /// @notice Change a project's lifecycle status.
    function updateProjectStatus(uint256 projectId, ProjectStatus status)
        external
        onlyAgentHolder
    {
        Project storage project = _project(msg.sender, projectId);
        project.status = status;
        project.lastActivityAt = uint64(block.timestamp);
        emit ProjectStatusUpdated(msg.sender, projectId, status);
    }

    /// @notice Replace a project's notes.
    function updateProjectNotes(uint256 projectId, string calldata notes)
        external
        onlyAgentHolder
    {
        Project storage project = _project(msg.sender, projectId);
        project.notes = notes;
        project.lastActivityAt = uint64(block.timestamp);
        emit ProjectNotesUpdated(msg.sender, projectId);
    }

    // ------------------------------------------------------------------------
    // Tasks
    // ------------------------------------------------------------------------

    /// @notice Add one task to a project.
    /// @return taskId Index of the new task within the project.
    function addTask(
        uint256 projectId,
        string calldata title,
        TaskKind kind,
        bool recurring
    ) external onlyAgentHolder returns (uint256 taskId) {
        if (bytes(title).length == 0) revert EmptyTitle();
        Project storage project = _project(msg.sender, projectId);
        taskId = _tasks[msg.sender][projectId].length;
        _tasks[msg.sender][projectId].push(
            Task({
                title: title,
                kind: kind,
                recurring: recurring,
                done: false,
                createdAt: uint64(block.timestamp),
                completedAt: 0
            })
        );
        project.taskCount += 1;
        project.lastActivityAt = uint64(block.timestamp);
        emit TaskAdded(msg.sender, projectId, taskId, title, kind);
    }

    /// @notice Add several tasks to a project in one transaction (gas saving).
    /// @dev All three arrays must have the same length.
    function addTasksBatch(
        uint256 projectId,
        string[] calldata titles,
        TaskKind[] calldata kinds,
        bool[] calldata recurrings
    ) external onlyAgentHolder returns (uint256 firstTaskId) {
        uint256 len = titles.length;
        if (len != kinds.length || len != recurrings.length) {
            revert BatchLengthMismatch();
        }
        Project storage project = _project(msg.sender, projectId);
        firstTaskId = _tasks[msg.sender][projectId].length;
        for (uint256 i = 0; i < len; ++i) {
            if (bytes(titles[i]).length == 0) revert EmptyTitle();
            _tasks[msg.sender][projectId].push(
                Task({
                    title: titles[i],
                    kind: kinds[i],
                    recurring: recurrings[i],
                    done: false,
                    createdAt: uint64(block.timestamp),
                    completedAt: 0
                })
            );
            emit TaskAdded(
                msg.sender,
                projectId,
                firstTaskId + i,
                titles[i],
                kinds[i]
            );
        }
        project.taskCount += uint32(len);
        project.lastActivityAt = uint64(block.timestamp);
    }

    /// @notice Mark a task done (or un-done). Sets/clears completedAt.
    function setTaskDone(uint256 projectId, uint256 taskId, bool done)
        external
        onlyAgentHolder
    {
        Project storage project = _project(msg.sender, projectId);
        Task[] storage taskList = _tasks[msg.sender][projectId];
        if (taskId >= taskList.length) revert TaskNotFound();
        Task storage task = taskList[taskId];
        if (task.done == done) return; // idempotent: no state change
        task.done = done;
        if (done) {
            task.completedAt = uint64(block.timestamp);
            project.tasksDone += 1;
        } else {
            task.completedAt = 0;
            project.tasksDone -= 1;
        }
        project.lastActivityAt = uint64(block.timestamp);
        emit TaskStatusChanged(msg.sender, projectId, taskId, done);
    }

    // ------------------------------------------------------------------------
    // Views (public reads, no Agent ID needed)
    // ------------------------------------------------------------------------

    function getProjectCount(address user) external view returns (uint256) {
        return _projects[user].length;
    }

    function getProject(address user, uint256 projectId)
        external
        view
        returns (Project memory)
    {
        if (projectId >= _projects[user].length) revert ProjectNotFound();
        return _projects[user][projectId];
    }

    function getTaskCount(address user, uint256 projectId)
        external
        view
        returns (uint256)
    {
        if (projectId >= _projects[user].length) revert ProjectNotFound();
        return _tasks[user][projectId].length;
    }

    function getTask(address user, uint256 projectId, uint256 taskId)
        external
        view
        returns (Task memory)
    {
        if (projectId >= _projects[user].length) revert ProjectNotFound();
        if (taskId >= _tasks[user][projectId].length) revert TaskNotFound();
        return _tasks[user][projectId][taskId];
    }

    /// @notice Dashboard stats for a user.
    /// @return projectCount Number of tracked projects.
    /// @return tasksDone Number of tasks marked done across all projects.
    /// @return tasksRemaining Number of tasks still open.
    function getStats(address user)
        external
        view
        returns (
            uint256 projectCount,
            uint256 tasksDone,
            uint256 tasksRemaining
        )
    {
        Project[] storage list = _projects[user];
        projectCount = list.length;
        uint256 total;
        for (uint256 i = 0; i < projectCount; ++i) {
            tasksDone += list[i].tasksDone;
            total += list[i].taskCount;
        }
        tasksRemaining = total - tasksDone;
    }

    /// @notice Whether an address holds an Agent ID (convenience for the UI).
    function isAgentHolder(address user) external view returns (bool) {
        return agentId.balanceOf(user) > 0;
    }

    // ------------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------------

    function _project(address user, uint256 projectId)
        private
        view
        returns (Project storage)
    {
        if (projectId >= _projects[user].length) revert ProjectNotFound();
        return _projects[user][projectId];
    }
}
