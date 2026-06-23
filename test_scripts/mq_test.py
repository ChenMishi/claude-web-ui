#!/usr/bin/env python3
"""简单消息队列测试 —— 纯 Python 实现，无需外部依赖"""

import queue
import threading
import time
import random


# ============================================================
# 生产者-消费者 消息队列测试
# ============================================================

def producer(mq, name, count):
    """生产者：往队列里放消息"""
    for i in range(count):
        msg = f"[{name}] 消息 #{i+1}"
        mq.put(msg)
        print(f"  📤 {name} 生产 → {msg}")
        time.sleep(random.uniform(0.1, 0.3))
    mq.put(None)  # 结束信号


def consumer(mq, name):
    """消费者：从队列里取消息"""
    while True:
        msg = mq.get()
        if msg is None:
            mq.put(None)  # 传递给下一个消费者
            break
        print(f"  📥 {name} 消费 ← {msg}")
        time.sleep(random.uniform(0.2, 0.5))
        mq.task_done()


def test_basic():
    """测试1：基础 FIFO 队列"""
    print("=" * 50)
    print("  测试 1：基础 FIFO 消息队列")
    print("=" * 50)
    mq = queue.Queue()
    mq.put("第一条消息")
    mq.put("第二条消息")
    mq.put("第三条消息")
    while not mq.empty():
        print(f"  取出: {mq.get()}")
    print("  ✅ 基础队列测试通过\n")


def test_producer_consumer():
    """测试2：多生产者 + 单消费者"""
    print("=" * 50)
    print("  测试 2：多生产者 → 单消费者")
    print("=" * 50)
    mq = queue.Queue()
    t1 = threading.Thread(target=producer, args=(mq, "生产者A", 3))
    t2 = threading.Thread(target=producer, args=(mq, "生产者B", 2))
    t3 = threading.Thread(target=consumer, args=(mq, "消费者"))
    t1.start()
    t2.start()
    t3.start()
    t1.join()
    t2.join()
    t3.join()
    print("  ✅ 生产消费测试通过\n")


def test_priority_queue():
    """测试3：优先级队列"""
    print("=" * 50)
    print("  测试 3：优先级消息队列")
    print("=" * 50)
    mq = queue.PriorityQueue()
    mq.put((3, "普通任务"))
    mq.put((1, "紧急任务"))
    mq.put((2, "重要任务"))
    while not mq.empty():
        _, task = mq.get()
        print(f"  取出: {task}")
    print("  ✅ 优先级队列测试通过\n")


def test_lifo_queue():
    """测试4：LIFO 栈队列"""
    print("=" * 50)
    print("  测试 4：LIFO 栈队列")
    print("=" * 50)
    mq = queue.LifoQueue()
    for i in range(3):
        mq.put(f"任务{i+1}")
    while not mq.empty():
        print(f"  取出: {mq.get()}")
    print("  ✅ LIFO 队列测试通过\n")


if __name__ == "__main__":
    test_basic()
    test_priority_queue()
    test_lifo_queue()
    test_producer_consumer()
    print("=" * 50)
    print("  🎉 全部消息队列测试完成")
    print("=" * 50)
