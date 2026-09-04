[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$installerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifest = Get-Content -Raw -LiteralPath (Join-Path $installerRoot 'components.json') | ConvertFrom-Json
$backend = Join-Path $installerRoot 'Install-MeihuaComponents.ps1'
$defaultDrive = if (Test-Path -LiteralPath 'D:\') { 'D:\' } else { 'C:\' }
$defaultRoot = Join-Path $defaultDrive $manifest.defaults.installFolder

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="梅花直播系统安装器" Width="1040" Height="760" MinWidth="920" MinHeight="680"
        WindowStartupLocation="CenterScreen" Background="#F6F7FB" FontFamily="Microsoft YaHei UI">
  <Window.Resources>
    <SolidColorBrush x:Key="Ink" Color="#172033"/>
    <SolidColorBrush x:Key="Muted" Color="#667085"/>
    <SolidColorBrush x:Key="Primary" Color="#4F46E5"/>
    <SolidColorBrush x:Key="Border" Color="#DDE2EA"/>
    <Style TargetType="Button">
      <Setter Property="Height" Value="42"/><Setter Property="Padding" Value="18,0"/>
      <Setter Property="FontWeight" Value="SemiBold"/><Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Background" Value="White"/><Setter Property="Foreground" Value="{StaticResource Ink}"/>
      <Setter Property="BorderBrush" Value="{StaticResource Border}"/>
    </Style>
    <Style TargetType="CheckBox">
      <Setter Property="Foreground" Value="{StaticResource Ink}"/><Setter Property="FontSize" Value="14"/>
      <Setter Property="VerticalContentAlignment" Value="Center"/><Setter Property="Cursor" Value="Hand"/>
    </Style>
  </Window.Resources>
  <Grid Margin="26">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto"/><RowDefinition Height="16"/><RowDefinition Height="Auto"/>
      <RowDefinition Height="16"/><RowDefinition Height="*"/><RowDefinition Height="16"/><RowDefinition Height="Auto"/>
    </Grid.RowDefinitions>

    <Grid Grid.Row="0">
      <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
      <StackPanel>
        <TextBlock Text="梅花直播系统" FontSize="28" FontWeight="Bold" Foreground="{StaticResource Ink}"/>
        <TextBlock Margin="0,7,0,0" Text="检查环境、安装所选组件、校验模型，然后直接进入生产运行。" FontSize="14" Foreground="{StaticResource Muted}"/>
      </StackPanel>
      <Border Grid.Column="1" Background="#EEF2FF" CornerRadius="8" Padding="14,9" VerticalAlignment="Center">
        <StackPanel Orientation="Horizontal"><Ellipse Width="8" Height="8" Fill="#4F46E5" Margin="0,0,8,0"/><TextBlock Text="私有仓库固定版本" Foreground="#3730A3" FontWeight="SemiBold"/></StackPanel>
      </Border>
    </Grid>

    <Border Grid.Row="2" Background="White" BorderBrush="{StaticResource Border}" BorderThickness="1" CornerRadius="10" Padding="18">
      <Grid>
        <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="16"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
        <StackPanel>
          <TextBlock Text="安装位置" FontWeight="SemiBold" Foreground="{StaticResource Ink}"/>
          <TextBox x:Name="InstallRoot" Margin="0,8,0,0" Height="40" Padding="10,8" FontSize="14" BorderBrush="{StaticResource Border}"/>
        </StackPanel>
        <Button x:Name="BrowseButton" Grid.Column="2" Width="96" Margin="0,23,0,0" Content="选择目录"/>
      </Grid>
    </Border>

    <Grid Grid.Row="4">
      <Grid.ColumnDefinitions><ColumnDefinition Width="1.08*"/><ColumnDefinition Width="16"/><ColumnDefinition Width="0.92*"/></Grid.ColumnDefinitions>
      <Border Background="White" BorderBrush="{StaticResource Border}" BorderThickness="1" CornerRadius="10" Padding="18">
        <Grid>
          <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="10"/><RowDefinition Height="*"/></Grid.RowDefinitions>
          <Grid>
            <TextBlock Text="选择组件" FontSize="18" FontWeight="Bold" Foreground="{StaticResource Ink}"/>
            <TextBlock x:Name="SizeText" HorizontalAlignment="Right" Text="预计 0 GB" Foreground="{StaticResource Muted}" VerticalAlignment="Center"/>
          </Grid>
          <ScrollViewer Grid.Row="2" VerticalScrollBarVisibility="Auto">
            <StackPanel x:Name="ComponentPanel"/>
          </ScrollViewer>
        </Grid>
      </Border>

      <Border Grid.Column="2" Background="White" BorderBrush="{StaticResource Border}" BorderThickness="1" CornerRadius="10" Padding="18">
        <Grid>
          <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="12"/><RowDefinition Height="Auto"/><RowDefinition Height="12"/><RowDefinition Height="*"/></Grid.RowDefinitions>
          <Grid>
            <TextBlock Text="安装状态" FontSize="18" FontWeight="Bold" Foreground="{StaticResource Ink}"/>
            <TextBlock x:Name="StatusText" HorizontalAlignment="Right" Text="等待检查" Foreground="{StaticResource Muted}" VerticalAlignment="Center"/>
          </Grid>
          <ProgressBar x:Name="Progress" Grid.Row="2" Height="9" Minimum="0" Maximum="100" Value="0" Foreground="{StaticResource Primary}" Background="#EEF0F5"/>
          <TextBox x:Name="LogBox" Grid.Row="4" IsReadOnly="True" TextWrapping="Wrap" VerticalScrollBarVisibility="Auto"
                   Background="#F8FAFC" Foreground="#344054" BorderBrush="#E4E7EC" Padding="12" FontFamily="Consolas" FontSize="12"/>
        </Grid>
      </Border>
    </Grid>

    <Grid Grid.Row="6">
      <Grid.ColumnDefinitions><ColumnDefinition Width="Auto"/><ColumnDefinition Width="10"/><ColumnDefinition Width="Auto"/><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
      <Button x:Name="CheckButton" Width="118" Content="检查环境"/>
      <Button x:Name="OpenButton" Grid.Column="2" Width="128" Content="打开安装目录"/>
      <Button x:Name="InstallButton" Grid.Column="4" Width="150" Background="{StaticResource Primary}" Foreground="White" BorderBrush="{StaticResource Primary}" Content="开始安装"/>
    </Grid>
  </Grid>
</Window>
'@

$reader = [System.Xml.XmlNodeReader]::new($xaml)
$window = [Windows.Markup.XamlReader]::Load($reader)
$installRootBox = $window.FindName('InstallRoot')
$componentPanel = $window.FindName('ComponentPanel')
$sizeText = $window.FindName('SizeText')
$statusText = $window.FindName('StatusText')
$progress = $window.FindName('Progress')
$logBox = $window.FindName('LogBox')
$checkButton = $window.FindName('CheckButton')
$installButton = $window.FindName('InstallButton')
$openButton = $window.FindName('OpenButton')
$browseButton = $window.FindName('BrowseButton')
$installRootBox.Text = $defaultRoot
$script:componentChecks = @{}
$script:activeProcess = $null

function Add-LogLine([string]$Line) {
  if (-not $Line) { return }
  if ($Line -match '^@@PROGRESS\s+(\d+)\s+(.*)$') {
    $progress.Value = [int]$Matches[1]
    $statusText.Text = $Matches[2]
    return
  }
  if ($Line -eq '@@FAILED') { return }
  $logBox.AppendText($Line + [Environment]::NewLine)
  $logBox.ScrollToEnd()
}

function Update-SelectionSummary {
  $size = 0.0
  foreach ($definition in $manifest.components) {
    $check = $script:componentChecks[$definition.id]
    if ($check -and $check.IsChecked) { $size += [double]$definition.estimatedGb }
  }
  $sizeText.Text = ('预计 {0:N1} GB + 2 GB 缓冲' -f $size)
}

foreach ($definition in $manifest.components) {
  $card = [Windows.Controls.Border]::new()
  $card.BorderBrush = '#E4E7EC'
  $card.BorderThickness = [Windows.Thickness]::new(0, 0, 0, 1)
  $card.Padding = [Windows.Thickness]::new(2, 12, 2, 12)
  $grid = [Windows.Controls.Grid]::new()
  $grid.ColumnDefinitions.Add([Windows.Controls.ColumnDefinition]::new())
  $auto = [Windows.Controls.ColumnDefinition]::new(); $auto.Width = 'Auto'; $grid.ColumnDefinitions.Add($auto)
  $stack = [Windows.Controls.StackPanel]::new()
  $check = [Windows.Controls.CheckBox]::new()
  $check.Content = $definition.name
  $check.FontWeight = 'SemiBold'
  $check.IsChecked = [bool]($definition.required -or ($manifest.defaults.components -contains $definition.id))
  $check.IsEnabled = -not [bool]$definition.required
  $check.Tag = $definition.id
  $description = [Windows.Controls.TextBlock]::new()
  $description.Text = $definition.description
  $description.Margin = '24,5,12,0'
  $description.Foreground = '#667085'
  $description.FontSize = 12
  $description.TextWrapping = 'Wrap'
  $stack.Children.Add($check) | Out-Null
  $stack.Children.Add($description) | Out-Null
  [Windows.Controls.Grid]::SetColumn($stack, 0)
  $grid.Children.Add($stack) | Out-Null
  $size = [Windows.Controls.TextBlock]::new()
  $size.Text = ('{0:N1} GB' -f [double]$definition.estimatedGb)
  $size.Foreground = '#667085'
  $size.VerticalAlignment = 'Center'
  [Windows.Controls.Grid]::SetColumn($size, 1)
  $grid.Children.Add($size) | Out-Null
  $card.Child = $grid
  $componentPanel.Children.Add($card) | Out-Null
  $script:componentChecks[$definition.id] = $check
  $check.Add_Checked({ Update-SelectionSummary })
  $check.Add_Unchecked({ Update-SelectionSummary })
}
Update-SelectionSummary

function Set-UiBusy([bool]$Busy) {
  $checkButton.IsEnabled = -not $Busy
  $installButton.IsEnabled = -not $Busy
  $browseButton.IsEnabled = -not $Busy
  foreach ($check in $script:componentChecks.Values) {
    if ($check.Tag -ne 'core') { $check.IsEnabled = -not $Busy }
  }
}

function Quote-Argument([string]$Value) {
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Start-Backend([string]$Action) {
  if ($script:activeProcess -and -not $script:activeProcess.HasExited) { return }
  $target = $installRootBox.Text.Trim()
  if (-not $target) { [Windows.MessageBox]::Show('请选择安装目录。', '梅花安装器') | Out-Null; return }
  $selected = @($script:componentChecks.GetEnumerator() | Where-Object { $_.Value.IsChecked } | ForEach-Object Key)
  $arguments = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Quote-Argument $backend),
    '-Action', $Action, '-InstallRoot', (Quote-Argument $target)
  )
  if ($Action -eq 'Install') { $arguments += @('-Components', (Quote-Argument ($selected -join ','))) }
  $psi = [Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = 'powershell.exe'
  $psi.Arguments = $arguments -join ' '
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $psi
  $process.EnableRaisingEvents = $true
  $process.add_OutputDataReceived({ param($sender, $eventArgs)
    if ($null -ne $eventArgs.Data) { $window.Dispatcher.BeginInvoke([Action[string]]{ param($line) Add-LogLine $line }, $eventArgs.Data) | Out-Null }
  })
  $process.add_ErrorDataReceived({ param($sender, $eventArgs)
    if ($null -ne $eventArgs.Data) { $window.Dispatcher.BeginInvoke([Action[string]]{ param($line) Add-LogLine ('错误：' + $line) }, $eventArgs.Data) | Out-Null }
  })
  $process.add_Exited({ param($sender, $eventArgs)
    $exitCode = $sender.ExitCode
    $window.Dispatcher.BeginInvoke([Action]{
      Set-UiBusy $false
      if ($exitCode -eq 0) {
        $progress.Value = 100
        $statusText.Text = if ($Action -eq 'Check') { '环境检查完成' } else { '安装完成' }
      } else {
        $statusText.Text = '操作失败，请查看日志'
      }
      $script:activeProcess = $null
    }) | Out-Null
  })
  $logBox.Clear()
  $progress.Value = 0
  $statusText.Text = if ($Action -eq 'Check') { '正在检查环境' } else { '正在准备安装' }
  Set-UiBusy $true
  if (-not $process.Start()) { Set-UiBusy $false; throw '无法启动安装任务。' }
  $script:activeProcess = $process
  $process.BeginOutputReadLine()
  $process.BeginErrorReadLine()
}

$browseButton.Add_Click({
  Add-Type -AssemblyName System.Windows.Forms
  $dialog = [Windows.Forms.FolderBrowserDialog]::new()
  $dialog.Description = '选择梅花直播系统安装目录'
  $dialog.SelectedPath = $installRootBox.Text
  if ($dialog.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) { $installRootBox.Text = $dialog.SelectedPath }
  $dialog.Dispose()
})
$openButton.Add_Click({
  $target = $installRootBox.Text.Trim()
  if (-not (Test-Path -LiteralPath $target)) { New-Item -ItemType Directory -Force -Path $target | Out-Null }
  Start-Process explorer.exe -ArgumentList $target
})
$checkButton.Add_Click({ Start-Backend 'Check' })
$installButton.Add_Click({ Start-Backend 'Install' })
$window.Add_Closing({
  if ($script:activeProcess -and -not $script:activeProcess.HasExited) {
    $answer = [Windows.MessageBox]::Show('安装任务仍在运行。确定要关闭窗口吗？', '梅花安装器', 'YesNo', 'Warning')
    if ($answer -ne 'Yes') { $_.Cancel = $true }
  }
})

$window.ShowDialog() | Out-Null
