import time
import random

def process_data(data):
    result = []
    for i, item in enumerate(data):
        print(f"[{i+1}/{len(data)}] Processing item: {item}")
        time.sleep(0.3)
        result.append(100 / item)  # item이 0이면 ZeroDivisionError
    return result

def main():
    print("=== LogPlus Test Project Start ===")
    print("데이터 초기화 중...")
    time.sleep(0.5)

    dataset = [10, 5, 2, 8, 3, 0, 7]  # 0이 포함되어 있어 에러 발생

    print(f"총 {len(dataset)}개 항목 처리 시작\n")

    try:
        results = process_data(dataset)
        print(f"\n처리 완료: {results}")
    except ZeroDivisionError as e:
        print(f"\n[ERROR] 0으로 나누기 오류 발생: {e}")
        raise

    print("=== 완료 ===")

if __name__ == "__main__":
    main()
