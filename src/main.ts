import { executionOrder } from './dag/graph.js';
import { defaultWorkflow } from './dag/workflow.js';

/** Phase 0 占位入口：验证脚手架与固定工作流定义。 */
export function main(): void {
  const order = executionOrder(defaultWorkflow())
    .map((node) => node.id)
    .join(' → ');
  console.log(`agentic-data-dag 脚手架就绪，固定工作流: ${order}`);
}

main();
