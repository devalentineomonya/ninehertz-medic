import { Controller, Get, Head } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from './auth/decorators/public.decorators';

@Controller()
export class AppController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @Public()
  @Head()
  handleHeadRequest(): { success: boolean } {
    return { success: true };
  }
  @Public()
  @Get()
  handleGetRequest(): { success: boolean } {
    return { success: true };
  }

  @Public()
  @Get('health')
  async handleHealthRequest(): Promise<{ success: boolean; db: boolean }> {
    await this.dataSource.query('SELECT 1');
    return { success: true, db: true };
  }
}
