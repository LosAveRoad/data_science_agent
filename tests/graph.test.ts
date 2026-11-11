import { describe, expect, it } from 'vitest';
import { DagValidationError, executionOrder, validateWorkflow } from '../src/dag/graph.js';
import { defaultWorkflow } from '../src/dag/workflow.js';

describe('executionOrder', () => {
  it('固定工作流按 Inspect → Plan → Execute → Verify 执行', () => {
    expect(executionOrder(defaultWorkflow()).map((node) => node.id)).toEqual([
      'inspect',
      'plan',
      'execute',
      'verify',
    ]);
  });

  it('无依赖节点保持定义顺序（确定性排序）', () => {
    const nodes = [
      { id: 'b', task: '', dependsOn: [], outputArtifacts: [] },
      { id: 'a', task: '', dependsOn: [], outputArtifacts: [] },
    ];
    expect(executionOrder({ id: 'w', nodes }).map((node) => node.id)).toEqual(['b', 'a']);
  });

  it('拒绝未知的依赖节点', () => {
    const nodes = [{ id: 'a', task: '', dependsOn: ['ghost'], outputArtifacts: [] }];
    expect(() => validateWorkflow({ id: 'w', nodes })).toThrow(DagValidationError);
  });

  it('拒绝环', () => {
    const nodes = [
      { id: 'a', task: '', dependsOn: ['b'], outputArtifacts: [] },
      { id: 'b', task: '', dependsOn: ['a'], outputArtifacts: [] },
    ];
    expect(() => validateWorkflow({ id: 'w', nodes })).toThrow(/环/);
  });

  it('拒绝重复节点 ID', () => {
    const nodes = [
      { id: 'a', task: '', dependsOn: [], outputArtifacts: [] },
      { id: 'a', task: '', dependsOn: [], outputArtifacts: [] },
    ];
    expect(() => validateWorkflow({ id: 'w', nodes })).toThrow(/重复/);
  });

  it('拒绝自依赖', () => {
    const nodes = [{ id: 'a', task: '', dependsOn: ['a'], outputArtifacts: [] }];
    expect(() => validateWorkflow({ id: 'w', nodes })).toThrow(/依赖自身/);
  });
});
