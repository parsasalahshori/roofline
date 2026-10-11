package dev.buildcli.plugin.roof;
import dev.buildcli.cli.BuildCLI;
import dev.buildcli.plugin.utils.BuildCLIPluginManager;
import picocli.CommandLine;
/** Automation launcher: real BuildCLI command tree and PF4J loading, correct error exit codes, no auto-update. */
public final class RooflineLauncher {
  public static void main(String[] args) {
    CommandLine cli = new CommandLine(new BuildCLI());
    BuildCLIPluginManager.registerPlugins(cli);
    System.exit(cli.execute(args));
  }
}
