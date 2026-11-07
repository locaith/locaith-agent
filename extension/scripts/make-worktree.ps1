# Tao mot git worktree rieng (nhanh moi) cho extension + noi san node_modules va market, de lam viec/ chay test song song ma khong dong vao cay chinh.
# ASCII only: Windows PowerShell 5.1 doc tep khong BOM theo ANSI nen chu co dau se vo.
#
#   powershell -File extension\scripts\make-worktree.ps1 -Name tools-parity            # nhanh feat/tools-parity tu main -> C:\locaith-agent-wt\tools-parity
#   powershell -File extension\scripts\make-worktree.ps1 -Name fix-x -BaseBranch main
#
# Luu y:
#  - Chi checkout thu muc `extension` (releases/ nang ~450 MB, khong can khi phat trien).
#  - `node_modules` va `market` la JUNCTION tro ve ban co san: DUNG npm install, DUNG xoa noi dung trong do.
#  - vsce (npm run package) bi loi EISDIR khi `market` la junction: truoc khi dong goi hay thay bang BAN SAO THAT (xem docs/PARITY-REMAINING.md muc 0).
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$BaseBranch = 'main',
  [string]$Repo = 'C:\locaith-agent-repo',
  [string]$Root = 'C:\locaith-agent-wt',
  [string]$NodeModules = 'C:\locaith\extension\locaith-agent-vscode\locaith-extension-main\node_modules',
  [string]$Market = 'C:\locaith\extension\locaith-agent-vscode\locaith-extension-main\market'
)
if (-not (Test-Path $NodeModules)) { throw "Khong thay node_modules: $NodeModules" }
New-Item -ItemType Directory -Force -Path $Root | Out-Null
$wt = Join-Path $Root $Name
$branch = "feat/$Name"
if (Test-Path $wt) { Write-Host "[$Name] da ton tai: $wt"; return }
# git ghi tien trinh ra stderr: PowerShell 5.1 coi do la loi neu dung $ErrorActionPreference='Stop', nen de mac dinh va tu kiem ket qua.
git -C $Repo worktree add --no-checkout -b $branch $wt $BaseBranch | Out-Null
git -C $wt sparse-checkout set extension | Out-Null
git -C $wt checkout $branch | Out-Null
if (-not (Test-Path (Join-Path $wt 'extension'))) { throw "Tao worktree that bai: $wt" }
New-Item -ItemType Junction -Path (Join-Path $wt 'extension\node_modules') -Target $NodeModules | Out-Null
if (Test-Path $Market) { New-Item -ItemType Junction -Path (Join-Path $wt 'extension\market') -Target $Market | Out-Null }
Write-Host "[$Name] OK  $wt  (nhanh $branch)"
