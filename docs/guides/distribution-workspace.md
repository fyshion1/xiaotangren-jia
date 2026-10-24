# 内核与发行组合：两仓库工作流

Shionarium 是唯一的内核源码仓库。小糖人之家是维护者的插件组合仓库，通过 Git 子模块引用内核的一个确定提交。插件可以集中在同一仓库；插件边界不要求独立 Git 仓库。

```text
xiaotangren-home/
  core/                 # Git 子模块，来源 fyshion1/shionarium
  plugins/              # 组合仓库管理的插件源码，无嵌套 Git 仓库
  local-data/           # 本地个人资料，忽略提交
  run.py                # 设置路径并调用内核启动器
```

## 路径契约

- 未设置 `SHIONARIUM_PLUGINS_DIR` 时仍加载内核根目录 `features/`，兼容已有安装，不迁移数据。
- 组合启动器把它设置为 `plugins/` 的绝对路径。后端、前端构建、安装器、插件管理与启动器使用同一个目录；不与默认插件目录自动合并。
- 这是可信本机代码加载路径，不是沙盒。不要指向陌生来源的插件目录。
- 前端插件用 `#shionarium/` 引用宿主前端模块，避免写死 `../../../frontend/src`。这是当前源码插件的宿主入口，仍需配套内核版本，不承诺完整稳定的公共 SDK。
- `SHIONARIUM_CORE_DIR` 由启动器传给插件进程，用于确有必要的同机文件访问。插件不得用插件目录的父级猜测内核位置。
- 关闭、隐藏和可恢复卸载继续工作。对组合仓库内插件执行卸载会移动已跟踪的源码，表现为 Git 删除；不要把个人卸载状态当作发行源码变更提交。固定代码、更新后重新应用本地卸载状态尚未自动化。

## GitHub 使用

普通使用者只克隆公开 Shionarium，按需安装插件。维护者使用私有组合仓库：

```powershell
git clone --recurse-submodules https://github.com/fyshion1/xiaotangren-home.git
cd xiaotangren-home
python run.py install
python run.py check
python run.py start
```

普通更新使用 `git pull` 后 `git submodule update --init core`，遵循组合仓库固定版本。不要为追最新而自动执行 `git submodule update --remote`。

开发内核时先在 `core/` 建分支，再提交并推送到 Shionarium。组合仓库只提交子模块指针；内核新提交必须先推送，否则其他机器无法取得。

`python run.py update-core --ref main` 是主动升级：检查内核没有未提交改动，获取指定分支并切换到对应提交。它不自动提交或推送。升级后重装依赖并测试，再 `git add core`、提交组合仓库。

## 数据与迁移

本轮不搬动已有工作目录，不复制日常数据库、模型、聊天、密钥、账号配置或个人资料。旧目录可继续日常使用。新组合是独立安装：核心运行数据默认仍在 `core/backend/data/`，模型配置在 `core/backend/.env`；插件自己的本地运行目录和 `local-data/` 均忽略提交。Git 子模块更新不等于数据迁移或备份。

已有独立插件仓库保留历史与既有公开下载地址；本次没有删除或自动归档它们。组合仓库内的插件以后集中维护，单独发布时应显式同步，不能声称两处自动同步。

小糖人之家包含未公开角色设定与素材，先保持私有。公开内核不代表这些内容也获得 Apache-2.0 许可，详见各仓库许可范围。
