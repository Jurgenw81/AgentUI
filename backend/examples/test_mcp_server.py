"""A tiny MCP tool server for testing AgentUI's MCP support. No network, no side effects.

Run by AgentUI as:  <backend venv python> backend/examples/test_mcp_server.py
"""
import datetime
import random

from mcp.server.mcpserver import MCPServer

app = MCPServer("agentui-test-tools")


@app.tool()
def roll_dice(sides: int = 6, count: int = 1) -> str:
    """Roll `count` dice with `sides` sides each and return every roll plus the total."""
    rolls = [random.randint(1, max(2, sides)) for _ in range(max(1, min(count, 20)))]
    return f"rolled {rolls} (total {sum(rolls)})"


@app.tool()
def celsius_to_fahrenheit(celsius: float) -> str:
    """Convert a temperature from Celsius to Fahrenheit."""
    return f"{celsius}°C = {celsius * 9 / 5 + 32:.1f}°F"


@app.tool()
def current_time() -> str:
    """Return the current local date and time on this computer."""
    return datetime.datetime.now().strftime("%A %Y-%m-%d %H:%M:%S")


if __name__ == "__main__":
    app.run()
